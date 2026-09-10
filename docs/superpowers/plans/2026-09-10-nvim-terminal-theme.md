# Neovim Terminal Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Neovim select Catppuccin Latte for light Mosh/tmux sessions and Mocha for dark sessions.

**Architecture:** Translate the existing `LC_TERMINAL_THEME` environment contract into Neovim's standard `background` option during option initialization, before plugin scripts load. Keep Catppuccin's automatic flavour selection and verify both theme values through the existing headless repository check.

**Tech Stack:** Lua (Neovim 0.12), Bash, Catppuccin.nvim, Chezmoi-managed dotfiles

## Global Constraints

- Accept only the exact values `light` and `dark` from `LC_TERMINAL_THEME`.
- Preserve Neovim's existing default when the variable is missing or invalid.
- Do not change shell, tmux, Mosh, or true-color configuration for this palette-selection bug.
- Preserve local and non-tmux behavior.

---

### Task 1: Map the terminal theme into Neovim

**Files:**
- Modify: `scripts/check-repository.sh:26`
- Modify: `dot_config/nvim/lua/config/options.lua:10-13`

**Interfaces:**
- Consumes: `vim.env.LC_TERMINAL_THEME`, with valid values `light` or `dark`.
- Produces: `vim.o.background` set before `plugin/00-catppuccin.lua` uses `flavour = "auto"`.

- [ ] **Step 1: Write failing headless theme checks**

Replace the single Neovim startup command in `scripts/check-repository.sh` with:

```bash
LC_TERMINAL_THEME=light nvim --headless --cmd "set runtimepath^=$repo/dot_config/nvim" -u "$repo/dot_config/nvim/init.lua" \
  "+lua if vim.o.background ~= 'light' or vim.g.colors_name ~= 'catppuccin-latte' then vim.api.nvim_err_writeln('light terminal theme did not select Catppuccin Latte'); vim.cmd.cquit() end" +qa
LC_TERMINAL_THEME=dark nvim --headless --cmd "set runtimepath^=$repo/dot_config/nvim" -u "$repo/dot_config/nvim/init.lua" \
  "+lua if vim.o.background ~= 'dark' or vim.g.colors_name ~= 'catppuccin-mocha' then vim.api.nvim_err_writeln('dark terminal theme did not select Catppuccin Mocha'); vim.cmd.cquit() end" +qa
LC_TERMINAL_THEME=sepia nvim --headless --cmd "set runtimepath^=$repo/dot_config/nvim" -u "$repo/dot_config/nvim/init.lua" \
  "+lua if vim.o.background ~= 'dark' or vim.g.colors_name ~= 'catppuccin-mocha' then vim.api.nvim_err_writeln('invalid terminal theme changed the default palette'); vim.cmd.cquit() end" +qa
env -u LC_TERMINAL_THEME nvim --headless --cmd "set runtimepath^=$repo/dot_config/nvim" -u "$repo/dot_config/nvim/init.lua" \
  "+lua if vim.o.background ~= 'dark' or vim.g.colors_name ~= 'catppuccin-mocha' then vim.api.nvim_err_writeln('missing terminal theme changed the default palette'); vim.cmd.cquit() end" +qa
```

- [ ] **Step 2: Run the light check to verify it fails**

Run:

```bash
LC_TERMINAL_THEME=light nvim --headless --cmd "set runtimepath^=$PWD/dot_config/nvim" -u "$PWD/dot_config/nvim/init.lua" \
  "+lua if vim.o.background ~= 'light' or vim.g.colors_name ~= 'catppuccin-latte' then vim.api.nvim_err_writeln('light terminal theme did not select Catppuccin Latte'); vim.cmd.cquit() end" +qa
```

Expected: nonzero exit with `light terminal theme did not set background=light` because Neovim currently remains dark.

- [ ] **Step 3: Implement the minimal environment mapping**

Immediately before `vim.opt.termguicolors` in `dot_config/nvim/lua/config/options.lua`, add:

```lua
local terminal_theme = vim.env.LC_TERMINAL_THEME
if terminal_theme == "light" or terminal_theme == "dark" then
  vim.opt.background = terminal_theme
end
```

- [ ] **Step 4: Run the focused checks to verify they pass**

Run:

```bash
bash scripts/check-repository.sh
```

Expected: exit 0; both Catppuccin palette assertions pass along with the existing Chezmoi boundary checks.

- [ ] **Step 5: Commit the behavioral fix and tests**

```bash
git add dot_config/nvim/lua/config/options.lua scripts/check-repository.sh
git commit -m "fix: sync Neovim with terminal theme"
```

---

### Task 2: Document live-session verification

**Files:**
- Modify: `README.md:51-56`

**Interfaces:**
- Consumes: applied dotfiles in a Mosh → tmux → Neovim session.
- Produces: commands that distinguish environment propagation failures from Neovim palette-selection failures.

- [ ] **Step 1: Add concise verification instructions**

After the Neovim lockfile paragraph in `README.md`, add:

````markdown
### Verify the terminal theme

After `chezmoi apply`, reconnect with Mosh, attach tmux, and open a new tmux window so it inherits the attached client's environment. In the shell, verify:

```bash
printf 'theme=%s term=%s\n' "$LC_TERMINAL_THEME" "$TERM"
tmux show-environment LC_TERMINAL_THEME
```

For a light terminal, both theme values should be `light`. Inside Neovim, run:

```vim
:echo $LC_TERMINAL_THEME
:set background?
:echo g:colors_name
```

The expected values are `light`, `background=light`, and `catppuccin-latte` (`dark`, `background=dark`, and `catppuccin-mocha` in dark mode).
````

- [ ] **Step 2: Run all repository validation**

Run:

```bash
npm test
npm run typecheck
npm run lint:shell
npm run check
```

Expected: all commands exit 0. `npm run check` validates both theme modes headlessly.

- [ ] **Step 3: Check the patch for whitespace and scope**

Run:

```bash
git diff --check
git status --short
git diff origin/main...HEAD --stat
```

Expected: no whitespace errors; only the approved design, plan, Neovim option, focused check, and README documentation are changed.

- [ ] **Step 4: Commit the documentation**

```bash
git add README.md docs/superpowers/plans/2026-09-10-nvim-terminal-theme.md
git commit -m "docs: explain Neovim terminal theme verification"
```
