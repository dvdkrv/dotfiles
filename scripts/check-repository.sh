#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

check_tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-check.XXXXXX")"
chezmoi_config="$check_tmpdir/chezmoi.toml"
: >"$chezmoi_config"
trap 'rm -rf "$check_tmpdir"' EXIT

for command in chezmoi jq nvim; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required for repository checks" >&2; exit 1; }
done

make check

managed="$(chezmoi --config "$chezmoi_config" --source "$repo" managed --path-style source-absolute)"
for root in README.md package.json package-lock.json tsconfig.json docs tests scripts pi-claude-bridge pi-loop-package pi-task pi-worktree-core pi-worktree-manager; do
  if grep -Fq -- "$repo/$root" <<<"$managed"; then
    echo "Repository-only source is managed by chezmoi: $root" >&2
    exit 1
  fi
done

LC_TERMINAL_THEME=light nvim --headless --cmd "set runtimepath^=$repo/dot_config/nvim" -u "$repo/dot_config/nvim/init.lua" \
  "+lua if vim.o.background ~= 'light' or vim.g.colors_name ~= 'catppuccin-latte' then vim.api.nvim_err_writeln('light terminal theme did not select Catppuccin Latte'); vim.cmd.cquit() end" +qa
LC_TERMINAL_THEME=dark nvim --headless --cmd "set runtimepath^=$repo/dot_config/nvim" -u "$repo/dot_config/nvim/init.lua" \
  "+lua if vim.o.background ~= 'dark' or vim.g.colors_name ~= 'catppuccin-mocha' then vim.api.nvim_err_writeln('dark terminal theme did not select Catppuccin Mocha'); vim.cmd.cquit() end" +qa
LC_TERMINAL_THEME=sepia nvim --headless --cmd "set runtimepath^=$repo/dot_config/nvim" -u "$repo/dot_config/nvim/init.lua" \
  "+lua if vim.o.background ~= 'dark' or vim.g.colors_name ~= 'catppuccin-mocha' then vim.api.nvim_err_writeln('invalid terminal theme changed the default palette'); vim.cmd.cquit() end" +qa
env -u LC_TERMINAL_THEME nvim --headless --cmd "set runtimepath^=$repo/dot_config/nvim" -u "$repo/dot_config/nvim/init.lua" \
  "+lua if vim.o.background ~= 'dark' or vim.g.colors_name ~= 'catppuccin-mocha' then vim.api.nvim_err_writeln('missing terminal theme changed the default palette'); vim.cmd.cquit() end" +qa
