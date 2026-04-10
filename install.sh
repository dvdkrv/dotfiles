#!/usr/bin/env bash
# Bootstrap dotfiles on a new machine via chezmoi.
# Usage: ./install.sh
set -e

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v chezmoi &>/dev/null; then
    sh -c "$(curl -fsLS get.chezmoi.io)" -- -b "$HOME/.local/bin"
    export PATH="$HOME/.local/bin:$PATH"
fi

# Trust the source dir — workspace environments may pre-populate it as a different UID
git config --global --add safe.directory "$DOTFILES_DIR"

chezmoi init --source "$DOTFILES_DIR" --apply
