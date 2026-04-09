#!/usr/bin/env bash
# fzf-tab is not available in Homebrew
set -e

ZSH_DIR="$HOME/.zsh"
mkdir -p "$ZSH_DIR"

if [ ! -d "$ZSH_DIR/fzf-tab" ]; then
    git clone https://github.com/Aloxaf/fzf-tab "$ZSH_DIR/fzf-tab"
fi
