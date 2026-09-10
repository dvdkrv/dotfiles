# Neovim Terminal Theme Design

## Goal

Make Neovim select the light Catppuccin palette when a Mosh → tmux session carries `LC_TERMINAL_THEME=light`, while preserving the existing dark default and local/non-tmux behavior.

## Root Cause

The shell and tmux already propagate `LC_TERMINAL_THEME`. In the failing environment, Neovim receives `LC_TERMINAL_THEME=light`, but its `background` option remains the default `dark`. Catppuccin uses `flavour = "auto"`, so it selects Mocha and the custom `CursorLine` highlight receives Mocha's dark `surface0` color.

## Design

During Neovim option initialization, read `vim.env.LC_TERMINAL_THEME`. If its value is exactly `light` or `dark`, assign it to `vim.opt.background` before plugin scripts load. Ignore missing or invalid values so Neovim retains its existing default.

This uses Neovim's standard background signal rather than coupling the environment variable directly to Catppuccin. Catppuccin can continue using `flavour = "auto"`, and other plugins can observe the same correct background setting.

No shell, tmux, Mosh, or true-color configuration changes are needed for this palette-selection bug.

## Validation

Extend the repository's headless Neovim check to verify:

- `LC_TERMINAL_THEME=light` produces `background=light` and `catppuccin-latte`.
- `LC_TERMINAL_THEME=dark` produces `background=dark` and `catppuccin-mocha`.
- Existing repository validation still passes.

Add concise manual verification instructions for checking the environment, Neovim background, and active colorscheme in a Mosh → tmux → Neovim session.
