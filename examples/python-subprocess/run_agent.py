#!/usr/bin/env python3
"""
run_agent.py - Run a Sparkwright agent from Python via subprocess.

Requires Python 3.9+ and no third-party packages.  Sparkwright must already
be built (npm install && npm run build) before using this script.

Usage:
    python run_agent.py "your goal here"
    python run_agent.py "inspect this repo" --workspace ../../examples/repo-pilot
    python run_agent.py "inspect and update README" --workspace ../../examples/repo-pilot --write --yes
    python run_agent.py "inspect this repo" --trace-level debug

Exit codes:
    0  Run succeeded (state == "completed")
    1  Run failed or was cancelled
    2  Usage / setup error (missing build, bad workspace, timeout)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_SUCCESS = 0
EXIT_RUN_FAILED = 1
EXIT_SETUP_ERROR = 2

INTERESTING_EVENT_TYPES = {
    "run.created",
    "run.started",
    "run.completed",
    "run.failed",
    "run.cancelled",
    "tool.completed",
    "tool.failed",
    "artifact.created",
    "approval.requested",
    "approval.resolved",
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_project_root(start: Path) -> Optional[Path]:
    """Walk up from *start* looking for a directory that contains
    ``packages/cli/dist/index.js``.  Returns the first match or None.
    """
    current = start.resolve()
    for _ in range(10):  # stop after 10 levels
        candidate = current / "packages" / "cli" / "dist" / "index.js"
        if candidate.exists():
            return current
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


def _resolve_cli_cmd(project_root: Path) -> list[str]:
    """Return the command list for invoking the sparkwright CLI.

    Tries, in order:
      1. npx sparkwright  (published / linked package)
      2. node <project_root>/packages/cli/dist/index.js  (local build)

    Raises SystemExit(EXIT_SETUP_ERROR) with a friendly message on failure.
    """
    import shutil

    if shutil.which("npx"):
        # Probe whether sparkwright is available through npx without
        # actually running a real command (avoids side effects).
        probe = subprocess.run(
            ["npx", "sparkwright", "--help"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if probe.returncode == 0 or "Usage" in probe.stdout or "sparkwright" in probe.stdout.lower():
            return ["npx", "sparkwright"]

    local_dist = project_root / "packages" / "cli" / "dist" / "index.js"
    if local_dist.exists():
        return ["node", str(local_dist)]

    print(
        "ERROR: Cannot locate the sparkwright CLI.\n"
        "\n"
        "Make sure you have built the project:\n"
        "  cd <project-root>\n"
        "  npm install\n"
        "  npm run build\n"
        "\n"
        f"Expected CLI dist at: {local_dist}\n"
        "Alternatively, install sparkwright globally:\n"
        "  npm install -g @sparkwright/cli",
        file=sys.stderr,
    )
    sys.exit(EXIT_SETUP_ERROR)


def _find_latest_run_dir(workspace: Path) -> Optional[Path]:
    """Return the most recently modified run directory under the workspace."""
    runs_dir = workspace / ".sparkwright" / "runs"
    if not runs_dir.is_dir():
        return None
    candidates = [d for d in runs_dir.iterdir() if d.is_dir()]
    if not candidates:
        return None
    return max(candidates, key=lambda d: d.stat().st_mtime)


def _read_jsonl(path: Path) -> list[dict]:
    """Parse a JSONL file into a list of dicts, skipping malformed lines."""
    events: list[dict] = []
    if not path.exists():
        return events
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return events


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------

def _format_event(event: dict) -> str:
    etype = event.get("type", "unknown")
    seq = event.get("sequence", "?")
    payload = event.get("payload") or {}

    if etype == "run.created":
        return f"[{seq}] run.created  run_id={event.get('runId', '?')}"

    if etype == "run.started":
        return f"[{seq}] run.started"

    if etype in ("run.completed", "run.failed", "run.cancelled"):
        reason = payload.get("reason") or payload.get("stopReason") or ""
        code = payload.get("code") or ""
        parts = [f"[{seq}] {etype}"]
        if reason:
            parts.append(f"reason={reason}")
        if code:
            parts.append(f"code={code}")
        return "  ".join(parts)

    if etype in ("tool.completed", "tool.failed"):
        tool_name = payload.get("toolName") or payload.get("toolCallId") or "?"
        status = payload.get("status") or ""
        return f"[{seq}] {etype}  tool={tool_name}  status={status}"

    if etype == "artifact.created":
        name = payload.get("name") or "?"
        atype = payload.get("type") or "?"
        return f"[{seq}] artifact.created  name={name}  type={atype}"

    if etype == "approval.requested":
        summary = payload.get("summary") or "?"
        return f"[{seq}] approval.requested  {summary}"

    if etype == "approval.resolved":
        decision = payload.get("decision") or "?"
        return f"[{seq}] approval.resolved  decision={decision}"

    return f"[{seq}] {etype}"


def _print_key_events(events: list[dict]) -> None:
    """Print a human-readable summary of the most interesting trace events."""
    interesting = [e for e in events if e.get("type") in INTERESTING_EVENT_TYPES]
    if not interesting:
        return
    print("\n--- Key trace events ---")
    for event in interesting:
        print("  " + _format_event(event))


def _print_result(result_data: dict, run_dir: Path) -> None:
    """Pretty-print the final run state block."""
    state = result_data.get("state", "unknown")
    stop_reason = result_data.get("stopReason") or ""
    message = result_data.get("message") or ""
    signal = result_data.get("signal") or ""

    print("\n--- Run result ---")
    print(f"  state:       {state}")
    if stop_reason:
        print(f"  stopReason:  {stop_reason}")
    if signal:
        print(f"  signal:      {signal}")
    if message:
        print(f"  message:     {message}")
    print(f"  run dir:     {run_dir}")
    print(f"  trace:       {run_dir / 'trace.jsonl'}")
    print(f"  result.json: {run_dir / 'result.json'}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="run_agent.py",
        description="Run a Sparkwright agent run via subprocess and report results.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            '  python run_agent.py "inspect this repo"\n'
            '  python run_agent.py "improve README" --workspace ../../examples/repo-pilot --write --yes\n'
            '  python run_agent.py "audit code quality" --trace-level debug'
        ),
    )
    parser.add_argument(
        "goal",
        help="Natural-language goal to pass to the agent.",
    )
    parser.add_argument(
        "--workspace",
        default=None,
        help=(
            "Path to the workspace directory the agent will read/write. "
            "Defaults to the current working directory."
        ),
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Allow the agent to write files (passes --write to sparkwright).",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Auto-approve all approval gates (passes --yes to sparkwright).",
    )
    parser.add_argument(
        "--trace-level",
        choices=["minimal", "standard", "debug"],
        default="standard",
        help="Trace verbosity level (default: standard).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=300,
        help="Maximum seconds to wait for the agent run (default: 300).",
    )
    parser.add_argument(
        "--project-root",
        default=None,
        help=(
            "Path to the Sparkwright project root (where packages/ lives). "
            "Auto-detected by walking up from this script's location if omitted."
        ),
    )
    parser.add_argument(
        "--no-trace-summary",
        action="store_true",
        help="Suppress the key-events trace summary printed at the end.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    # --- Resolve project root -----------------------------------------------
    if args.project_root:
        project_root = Path(args.project_root).resolve()
        if not project_root.is_dir():
            print(
                f"ERROR: --project-root does not exist: {project_root}",
                file=sys.stderr,
            )
            return EXIT_SETUP_ERROR
    else:
        script_dir = Path(__file__).resolve().parent
        project_root = _find_project_root(script_dir)
        if project_root is None:
            print(
                "ERROR: Could not auto-detect the Sparkwright project root.\n"
                "Run this script from inside the monorepo, or pass --project-root.",
                file=sys.stderr,
            )
            return EXIT_SETUP_ERROR

    # --- Resolve workspace ---------------------------------------------------
    if args.workspace:
        workspace = Path(args.workspace).resolve()
    else:
        workspace = Path.cwd()

    if not workspace.exists():
        print(
            f"ERROR: Workspace directory does not exist: {workspace}\n"
            "Create the directory or pass a valid --workspace path.",
            file=sys.stderr,
        )
        return EXIT_SETUP_ERROR

    # --- Locate CLI ---------------------------------------------------------
    try:
        cli_cmd = _resolve_cli_cmd(project_root)
    except SystemExit:
        raise  # already printed a message

    # --- Build command ------------------------------------------------------
    cmd = cli_cmd + ["run", args.goal]
    cmd += ["--workspace", str(workspace)]
    cmd += ["--trace-level", args.trace_level]
    if args.write:
        cmd.append("--write")
    if args.yes:
        cmd.append("--yes")

    print(f"Running: {' '.join(cmd)}")
    print(f"Workspace: {workspace}")
    print()

    # --- Execute ------------------------------------------------------------
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=args.timeout,
        )
    except subprocess.TimeoutExpired:
        print(
            f"\nERROR: Agent run timed out after {args.timeout}s.\n"
            "The run may still have written partial output.\n"
            "Try increasing --timeout.",
            file=sys.stderr,
        )
        return EXIT_SETUP_ERROR
    except FileNotFoundError as exc:
        print(
            f"\nERROR: Failed to start the CLI process: {exc}\n"
            "Ensure Node.js is installed and on PATH.",
            file=sys.stderr,
        )
        return EXIT_SETUP_ERROR

    # Print CLI output so the user can follow along.
    if proc.stdout.strip():
        print(proc.stdout.strip())
    if proc.stderr.strip():
        print(proc.stderr.strip(), file=sys.stderr)

    # --- Load run output ----------------------------------------------------
    run_dir = _find_latest_run_dir(workspace)
    if run_dir is None:
        print(
            f"\nERROR: No run output found under {workspace / '.sparkwright' / 'runs'}.\n"
            "The CLI may have failed before creating the run directory.\n"
            "Check the output above for clues.",
            file=sys.stderr,
        )
        return EXIT_SETUP_ERROR

    result_path = run_dir / "result.json"
    trace_path = run_dir / "trace.jsonl"

    result_data: dict = {}
    if result_path.exists():
        try:
            with result_path.open("r", encoding="utf-8") as fh:
                result_data = json.load(fh)
        except json.JSONDecodeError as exc:
            print(
                f"WARNING: Could not parse result.json: {exc}",
                file=sys.stderr,
            )

    events = _read_jsonl(trace_path)

    # --- Print summary ------------------------------------------------------
    _print_result(result_data, run_dir)

    if not args.no_trace_summary:
        _print_key_events(events)

    # --- Exit code ----------------------------------------------------------
    state = result_data.get("state", "unknown")
    if state == "completed":
        return EXIT_SUCCESS
    return EXIT_RUN_FAILED


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
