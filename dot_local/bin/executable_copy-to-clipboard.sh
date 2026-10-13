#!/usr/bin/env bash
set -euo pipefail

if command -v pbcopy >/dev/null 2>&1; then
  exec pbcopy
elif command -v wl-copy >/dev/null 2>&1; then
  exec wl-copy
elif command -v xclip >/dev/null 2>&1; then
  exec xclip -selection clipboard
fi

echo "No clipboard command found (tried pbcopy, wl-copy, and xclip)" >&2
exit 1
