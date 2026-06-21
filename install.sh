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

echo "Installing Sparkwright into ${SPARKWRIGHT_INSTALL_ROOT:-$HOME/.sparkwright}..."
node scripts/install-from-source.mjs

echo
echo "Sparkwright is installed for local use:"
echo "  sparkwright doctor paths --workspace ."
echo "  sparkwright tui"
echo "  sparkwright run \"inspect this repo\" --workspace . --model deterministic"
