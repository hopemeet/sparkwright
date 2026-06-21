#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required but was not found on PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required but was not found on PATH." >&2
  exit 1
fi

echo "Installing workspace dependencies..."
npm install

echo "Building Sparkwright..."
npm run build

echo "Linking the sparkwright command to this source checkout..."
npm link --workspace @sparkwright/cli

if command -v sparkwright >/dev/null 2>&1; then
  echo
  echo "Sparkwright is linked for development:"
  echo "  $(command -v sparkwright)"
  echo "  sparkwright doctor paths --workspace ."
else
  echo
  echo "Sparkwright was linked, but the sparkwright command is not on PATH." >&2
  echo "Check your npm global bin directory and shell PATH." >&2
  exit 1
fi
