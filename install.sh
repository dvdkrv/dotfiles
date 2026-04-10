#!/usr/bin/env bash
# Bootstrap dotfiles on a new machine via chezmoi.
# Usage: ./install.sh
set -e

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v chezmoi &>/dev/null; then
    sh -c "$(curl -fsLS get.chezmoi.io)" -- -b "$HOME/.local/bin"
    export PATH="$HOME/.local/bin:$PATH"
fi

# Write chezmoi config manually and apply directly — avoids `chezmoi init`
# which runs git against the source dir and fails when .git is owned by a
# different UID (common in workspace environments that pre-populate dotfiles).
CHEZMOI_CFG="$HOME/.config/chezmoi/chezmoi.toml"
if [[ ! -f "$CHEZMOI_CFG" ]]; then
    mkdir -p "$(dirname "$CHEZMOI_CFG")"
    cat > "$CHEZMOI_CFG" <<EOF
sourceDir = "$DOTFILES_DIR"

[data]
    work = false
EOF
fi

chezmoi apply --source "$DOTFILES_DIR"
