#!/usr/bin/env bash
set -e

ZSH_DIR="$HOME/.zsh"
mkdir -p "$ZSH_DIR"

# Clone brew-less fallback plugins when brew is not available (e.g. workspaces without Linuxbrew)
if ! command -v brew &>/dev/null; then
    if [ ! -d "$ZSH_DIR/zsh-autosuggestions" ]; then
        git clone https://github.com/zsh-users/zsh-autosuggestions "$ZSH_DIR/zsh-autosuggestions"
    fi
    if [ ! -d "$ZSH_DIR/zsh-syntax-highlighting" ]; then
        git clone https://github.com/zsh-users/zsh-syntax-highlighting "$ZSH_DIR/zsh-syntax-highlighting"
    fi
fi

# fzf-tab is not available in Homebrew — always clone
if [ ! -d "$ZSH_DIR/fzf-tab" ]; then
    git clone https://github.com/Aloxaf/fzf-tab "$ZSH_DIR/fzf-tab"
fi
