#!/usr/bin/env python3
"""Fail on unrouted hot-file changes or stale routed project-map pages."""

from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


MAP_README = Path("docs/_internal/project-map/README.md")
ROUTE_HEADING = "## Touch File -> Read Docs"
NEXT_HEADING = re.compile(r"^##\s+")
ALLOWED_STATUSES = {"Verified", "Read-only", "Stale?"}
HOTSPOT_PATTERNS = (
    "packages/host/src/runtime/*",
    "packages/host/src/config/*",
    "packages/cli/src/commands/*",
    "packages/cli/src/parser/*",
    "packages/core/src/runtime/*",
    "packages/coding-tools/src/*",
    "packages/mcp-adapter/src/*",
    "packages/cli/test/support/*",
)


@dataclass(frozen=True)
class Route:
    patterns: tuple[str, ...]
    docs: tuple[str, ...]


def run_git(args: list[str], cwd: Path) -> str:
    return subprocess.check_output(
        ["git", *args], cwd=cwd, text=True, stderr=subprocess.PIPE
    )


def repo_root() -> Path:
    try:
        return Path(run_git(["rev-parse", "--show-toplevel"], Path.cwd()).strip())
    except subprocess.CalledProcessError:
        print("error: run this script inside a git checkout", file=sys.stderr)
        sys.exit(2)


def parse_routes(readme: Path, root: Path) -> list[Route]:
    lines = readme.read_text(encoding="utf-8").splitlines()
    try:
        start = lines.index(ROUTE_HEADING) + 1
    except ValueError:
        raise ValueError(f"missing heading {ROUTE_HEADING!r} in {MAP_README}")

    routes: list[Route] = []
    for line in lines[start:]:
        if NEXT_HEADING.match(line):
            break
        if not line.startswith("- "):
            continue
        left, _, right = line.partition(":")
        patterns = tuple(re.findall(r"`([^`]+)`", left))
        docs = tuple(
            (readme.parent / match).resolve().relative_to(root).as_posix()
            for match in re.findall(r"\]\(([^)]+)\)", right)
        )
        if patterns and docs:
            routes.append(Route(patterns=patterns, docs=docs))
    return routes


def changed_files(cwd: Path, base: str | None) -> set[str]:
    changed: set[str] = set()
    if base:
        changed.update(run_git(["diff", "--name-only", f"{base}...HEAD"], cwd).splitlines())
    changed.update(run_git(["diff", "--name-only", "HEAD"], cwd).splitlines())
    changed.update(
        run_git(["ls-files", "--others", "--exclude-standard"], cwd).splitlines()
    )
    return {line.strip() for line in changed if line.strip()}


def changed_last_verified_date(cwd: Path, path: str, base: str | None) -> bool:
    ranges = [f"{base}...HEAD"] if base else []
    ranges.append("HEAD")
    for diff_range in ranges:
        diff = run_git(["diff", "--unified=0", diff_range, "--", path], cwd)
        if any(re.match(r"^\+- Date:|^-\+- Date:", line) for line in diff.splitlines()):
            return True
        if any(line.startswith("+- Date:") for line in diff.splitlines()):
            return True
    return False


def matches(pattern: str, file_path: str) -> bool:
    return fnmatch.fnmatchcase(file_path, pattern) if any(ch in pattern for ch in "*?[") else file_path == pattern


def invalid_statuses(root: Path) -> list[str]:
    invalid: list[str] = []
    for file_path in sorted((root / "docs/_internal/project-map").rglob("*.md")):
        for line_number, line in enumerate(file_path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.startswith("- Status:"):
                continue
            status = line.removeprefix("- Status:").strip()
            if status not in ALLOWED_STATUSES:
                invalid.append(f"{file_path.relative_to(root)}:{line_number}: {status}")
    return invalid


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="Include committed changes since this base ref.")
    args = parser.parse_args()
    root = repo_root()

    invalid = invalid_statuses(root)
    if invalid:
        print("invalid project-map status (use Verified, Read-only, or Stale?):", file=sys.stderr)
        for item in invalid:
            print(f"- {item}", file=sys.stderr)
        return 1

    try:
        routes = parse_routes(root / MAP_README, root)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    changed = changed_files(root, args.base)
    route_hits = [
        (file_path, route)
        for file_path in sorted(changed)
        if not file_path.startswith("docs/_internal/project-map/")
        for route in routes
        if any(matches(pattern, file_path) for pattern in route.patterns)
    ]
    routed_files = {file_path for file_path, _ in route_hits}
    unrouted = [
        file_path
        for file_path in sorted(changed)
        if any(matches(pattern, file_path) for pattern in HOTSPOT_PATTERNS)
        and file_path not in routed_files
    ]
    if unrouted:
        print("unrouted project-map hotspots:", file=sys.stderr)
        for file_path in unrouted:
            print(f"- {file_path}: add a Touch File -> Read Docs route", file=sys.stderr)
        return 1

    stale_docs: set[str] = set()
    for _, route in route_hits:
        for doc in route.docs:
            if doc not in changed or not changed_last_verified_date(root, doc, args.base):
                stale_docs.add(doc)
    if stale_docs:
        print("project-map pages need review/date refresh:", file=sys.stderr)
        for doc in sorted(stale_docs):
            print(f"- {doc}", file=sys.stderr)
        return 1

    print(
        f"Project-map drift OK: {len(routed_files)} routed changed files, 0 unrouted hotspots."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
