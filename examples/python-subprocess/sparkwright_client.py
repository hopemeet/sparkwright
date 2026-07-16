"""
sparkwright_client.py - Lightweight Python helper for running Sparkwright agent harness.

No third-party dependencies required. Uses only Python standard library.
Compatible with Python 3.9+.

Usage:
    from sparkwright_client import SparkwrightClient

    client = SparkwrightClient(project_root="/path/to/sparkwright")
    result = client.run("inspect this repo and suggest improvements",
                        workspace="examples/repo-pilot",
                        trace_level="standard")
    if result.succeeded:
        print(result.message)
    for event in result.find_events("tool.completed"):
        print(event)
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass
class RunResult:
    """Represents the outcome of a single Sparkwright agent run."""

    run_id: str
    state: str                  # "completed" | "failed" | "cancelled"
    stop_reason: Optional[str]
    message: Optional[str]
    trace_path: str             # absolute path to trace.jsonl
    events: list[dict] = field(default_factory=list)

    @property
    def succeeded(self) -> bool:
        """Return True if the run reached the 'completed' state."""
        return self.state == "completed"

    def find_events(self, event_type: str) -> list[dict]:
        """Return all trace events whose ``type`` field matches *event_type*.

        Args:
            event_type: Sparkwright event type string, e.g. "tool.completed",
                        "run.created", "artifact.created".
        """
        return [e for e in self.events if e.get("type") == event_type]

    def get_artifacts(self) -> list[dict]:
        """Return every ``artifact.created`` event payload from the trace."""
        return self.find_events("artifact.created")


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class SparkwrightClient:
    """Thin Python wrapper around the Sparkwright CLI.

    Finds the ``sparkwright`` binary by trying, in order:
      1. ``npx sparkwright`` (works when the CLI is published to npm)
      2. ``node <project_root>/packages/cli/dist/index.js`` (local build)

    Args:
        project_root: Absolute (or relative) path to the root of the
                      Sparkwright monorepo checkout where ``npm run build``
                      has been run.
        workspace:    Default workspace directory passed to ``--workspace``.
                      If *None*, each call must supply one explicitly.
    """

    def __init__(
        self,
        project_root: str,
        workspace: Optional[str] = None,
    ) -> None:
        self.project_root = Path(project_root).resolve()
        self.default_workspace: Optional[Path] = (
            Path(workspace).resolve() if workspace else None
        )
        self._cli_cmd: Optional[list[str]] = None  # resolved lazily

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(
        self,
        goal: str,
        *,
        workspace: Optional[str] = None,
        access_mode: str = "read-only",
        trace_level: str = "standard",
        timeout: int = 300,
    ) -> RunResult:
        """Execute a Sparkwright agent run synchronously and return the result.

        Args:
            goal:        Natural-language goal string passed to the agent.
            workspace:   Workspace path for this run (overrides the default
                         set in the constructor).
            access_mode: Run autonomy preset: ``read-only``, ``ask``,
                         ``accept-edits``, or ``bypass``.
            trace_level: One of ``"minimal"``, ``"standard"``, or ``"debug"``.
            timeout:     Maximum seconds to wait for the subprocess.

        Returns:
            A :class:`RunResult` populated from the trace and result.json
            written by the CLI.

        Raises:
            RuntimeError: If the CLI binary cannot be located.
            FileNotFoundError: If the workspace directory does not exist.
            TimeoutError: If the subprocess exceeds *timeout* seconds.
            subprocess.CalledProcessError: If the subprocess exits with a
                non-zero code and no result.json was written.
        """
        ws_path = self._resolve_workspace(workspace)
        cmd = self._build_command(goal, ws_path, access_mode, trace_level)

        try:
            proc = subprocess.run(
                cmd,
                cwd=str(self.project_root),
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(
                f"sparkwright run timed out after {timeout}s. "
                "Try increasing the timeout parameter."
            ) from exc

        # Try to read result.json regardless of exit code — the CLI may have
        # written a result even when it exits non-zero (e.g. run.failed).
        run_dir = _find_latest_run_dir(ws_path)
        if run_dir is None:
            # Nothing was written — surface the subprocess output as an error.
            raise RuntimeError(
                f"sparkwright did not write any run output under "
                f"{ws_path / '.sparkwright' / 'sessions'}.\n"
                f"CLI stdout: {proc.stdout.strip()}\n"
                f"CLI stderr: {proc.stderr.strip()}"
            )

        return self._load_run_result(run_dir)

    def get_run_events(self, run_id: str, workspace: Optional[str] = None) -> list[dict]:
        """Read the full trace event list for a specific run ID.

        Args:
            run_id:    The run identifier stored in the canonical session tree.
            workspace: Workspace path containing the ``.sparkwright`` tree.
                       Falls back to the constructor default.

        Returns:
            List of parsed event dicts, in sequence order.
        """
        ws_path = self._resolve_workspace(workspace)
        run_dir = _find_run_dir(ws_path, run_id)
        if run_dir is None:
            raise FileNotFoundError(
                f"Run directory not found in session storage: {run_id}"
            )
        return [
            event
            for event in _read_trace_jsonl(_trace_path_for_run_dir(run_dir))
            if event.get("runId") == run_id
        ]

    def get_latest_run(self, workspace: Optional[str] = None) -> Optional[RunResult]:
        """Load the most recently created run in the workspace.

        Returns *None* if no runs exist yet.

        Args:
            workspace: Workspace path.  Falls back to the constructor default.
        """
        ws_path = self._resolve_workspace(workspace)
        run_dir = _find_latest_run_dir(ws_path)
        if run_dir is None:
            return None
        return self._load_run_result(run_dir)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _resolve_workspace(self, workspace: Optional[str]) -> Path:
        if workspace is not None:
            p = Path(workspace).resolve()
        elif self.default_workspace is not None:
            p = self.default_workspace
        else:
            raise ValueError(
                "No workspace specified. Pass workspace= to the method or "
                "set a default in SparkwrightClient(workspace=...)."
            )
        if not p.exists():
            raise FileNotFoundError(
                f"Workspace directory does not exist: {p}\n"
                "Create the directory or point --workspace at an existing path."
            )
        return p

    def _resolve_cli_cmd(self) -> list[str]:
        """Locate the sparkwright binary, caching the result."""
        if self._cli_cmd is not None:
            return self._cli_cmd

        # Option 1: npx sparkwright (published package)
        if _command_exists("npx"):
            self._cli_cmd = ["npx", "sparkwright"]
            return self._cli_cmd

        # Option 2: node + local dist
        local_dist = self.project_root / "packages" / "cli" / "dist" / "index.js"
        if local_dist.exists():
            self._cli_cmd = ["node", str(local_dist)]
            return self._cli_cmd

        raise RuntimeError(
            "Cannot locate the sparkwright CLI.\n"
            "Either:\n"
            "  • Run 'npm install && npm run build' inside the project root, or\n"
            "  • Install sparkwright globally: npm install -g @sparkwright/cli\n"
            f"Searched for local dist at: {local_dist}"
        )

    def _build_command(
        self,
        goal: str,
        workspace: Path,
        access_mode: str,
        trace_level: str,
    ) -> list[str]:
        cmd = self._resolve_cli_cmd() + ["run", goal]
        cmd += ["--workspace", str(workspace)]
        cmd += ["--trace-level", trace_level]
        if access_mode not in {"read-only", "ask", "accept-edits", "bypass"}:
            raise ValueError(f"Unsupported access mode: {access_mode}")
        cmd += ["--access-mode", access_mode]
        return cmd

    def _load_run_result(self, run_dir: Path) -> RunResult:
        result_path = run_dir / "result.json"
        trace_path = _trace_path_for_run_dir(run_dir)

        result_data: dict = {}
        if result_path.exists():
            with result_path.open("r", encoding="utf-8") as fh:
                result_data = json.load(fh)

        events = [
            event
            for event in _read_trace_jsonl(trace_path)
            if event.get("runId") == run_dir.name
        ] if trace_path.exists() else []

        return RunResult(
            run_id=run_dir.name,
            state=result_data.get("state", "unknown"),
            stop_reason=result_data.get("stopReason"),
            message=result_data.get("message"),
            trace_path=str(trace_path),
            events=events,
        )


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------

def _find_latest_run_dir(workspace: Path) -> Optional[Path]:
    """Return the most recently modified canonical session run directory."""
    sessions_dir = workspace / ".sparkwright" / "sessions"
    if not sessions_dir.is_dir():
        return None

    candidates = [
        path
        for path in sessions_dir.glob("*/agents/*/runs/*")
        if path.is_dir()
    ]
    if not candidates:
        return None

    # Sort by mtime descending; pick the newest.
    return max(candidates, key=lambda d: d.stat().st_mtime)


def _find_run_dir(workspace: Path, run_id: str) -> Optional[Path]:
    """Find the newest canonical session run directory for *run_id*."""
    sessions_dir = workspace / ".sparkwright" / "sessions"
    candidates = [
        path
        for path in sessions_dir.glob(f"*/agents/*/runs/{run_id}")
        if path.is_dir()
    ]
    return max(candidates, key=lambda d: d.stat().st_mtime) if candidates else None


def _trace_path_for_run_dir(run_dir: Path) -> Path:
    """Return the aggregate session trace for a canonical run directory."""
    return run_dir.parents[3] / "trace.jsonl"


def _read_trace_jsonl(trace_path: Path) -> list[dict]:
    """Parse a JSONL trace file and return a list of event dicts."""
    events: list[dict] = []
    if not trace_path.exists():
        return events

    with trace_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # skip malformed lines silently

    return events


def _command_exists(name: str) -> bool:
    """Return True if *name* resolves to an executable on PATH."""
    import shutil
    return shutil.which(name) is not None
