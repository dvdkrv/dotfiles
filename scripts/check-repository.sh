#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

removed_transport="$(printf '\155\157\163\150')"
if git grep -in -- "$removed_transport"; then
  echo "Removed terminal transport remains in tracked source" >&2
  exit 1
fi
unset removed_transport

# Repository boundary: no employer identifiers in tracked files; they belong in the private layer.
# Spelled in octal so that this file passes its own check.
boundary_pattern="$(printf '\144\141\164\141\144\157\147|\144\144\157\147|\144\157\147\142\162\145\167|\141\151\055\147\167')"
if git grep -nIiE -- "$boundary_pattern"; then
  echo "Employer identifier in tracked files; move it to the private layer" >&2
  exit 1
fi
unset boundary_pattern
# End repository boundary

check_tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-check.XXXXXX")"
chezmoi_config="$check_tmpdir/chezmoi.toml"
: >"$chezmoi_config"
trap 'rm -rf "$check_tmpdir"' EXIT

for command in chezmoi jq nvim; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required for repository checks" >&2; exit 1; }
done

make check

managed="$(chezmoi --config "$chezmoi_config" --source "$repo" managed --path-style source-absolute)"
for root in README.md package.json package-lock.json docs tests scripts; do
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
