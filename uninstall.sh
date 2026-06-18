#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${SPARKWRIGHT_INSTALL_ROOT:-$HOME/.sparkwright}"

if [[ ! -e "$INSTALL_ROOT" ]]; then
  echo "Sparkwright install root does not exist: $INSTALL_ROOT"
  exit 0
fi

echo "Removing Sparkwright program files from $INSTALL_ROOT"
rm -rf "$INSTALL_ROOT/bin" "$INSTALL_ROOT/current" "$INSTALL_ROOT/versions" "$INSTALL_ROOT/cache"

echo
echo "Removed program files."
echo "User config and state were left untouched:"
echo "  ${XDG_CONFIG_HOME:-$HOME/.config}/sparkwright"
echo "  ${XDG_STATE_HOME:-$HOME/.local/state}/sparkwright"
echo "Project .sparkwright directories were left untouched."
