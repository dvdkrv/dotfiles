# Dotfiles

Personal macOS and Linux configuration managed with [chezmoi](https://www.chezmoi.io/). The repository provisions signed Pi packages alongside Neovim, shell, tmux, and machine configuration.

## Install

Clone the repository and run the canonical installer:

```bash
./install.sh
```

`bootstrap.sh` is a compatibility wrapper around `install.sh`. The installer obtains chezmoi when necessary and applies this checkout as its source. Chezmoi then installs Homebrew, packages, pinned shell plugins, Pi, and configured Pi packages.

During initialization, choose whether the machine has an Ansible-managed work zsh configuration:

- work machine: deploy `~/.personal-zshrc` and leave `~/.zshrc` unmanaged;
- personal machine: deploy `~/.zshrc` and leave `~/.personal-zshrc` unmanaged.

Repository-only directories such as `docs/`, `tests/`, and `scripts/` are never deployed into `$HOME`.

## Safety

Worktrees created by `/task` use conservative cleanup. Automatic cleanup never force-removes a worktree and never deletes its branch. Clean worktrees may be safely removed; dirty worktrees and all branches are preserved for explicit recovery or cleanup.

The `/task` command is interactive and user-invoked only. It is not exposed as a model-callable tool. Agents must not use it for autonomous subagent work. If parallel work is genuinely needed and the user has not outlined a task handoff, use headless Pi agents directly.

SSH configuration is managed through one validated marker block. Unbalanced markers cause the apply step to fail without modifying the existing file.

## Pi peer messaging

The signed [`pi-tools`](https://github.com/dvdkrv/pi-tools) `v0.1.1` release lets explicitly joined Pi sessions exchange messages. A human-armed group allowance bounds automatic handoffs; agents cannot re-arm it. The package may ensure its private loopback NATS broker is ready, but loading it never joins, resumes, arms, delivers, reads pending bodies, or invokes a model.

See the package README for setup, lifecycle recovery, and isolated no-inference test commands.

## Optional work model refresh

When `~/dd/datadog-pi-packages/packages/refresh-models` already exists, the managed Pi settings load it as a private work extension and expose `/refresh-models`. Dotfiles only declares the existing checkout; it does not clone, update, build, or install dependencies for that repository.

After applying a settings change, start a new Pi process or run `/reload` at an explicit idle boundary. Updating the private checkout also requires an explicit reload before an existing Pi process uses the new code.

## Development

Install exact development dependencies:

```bash
npm ci
```

Run validation:

```bash
npm test
npm run lint:shell
npm run check
```

`npm run check` renders JSON templates, confirms repository-only Chezmoi boundaries, and starts Neovim headlessly. It requires `chezmoi`, `jq`, and Neovim 0.12.

The authoritative Neovim plugin lockfile is `dot_config/nvim/nvim-pack-lock.json`.

### Verify the terminal theme

After `chezmoi apply`, connect from Ghostty using direct SSH, attach tmux, and load the managed configuration once at an explicit idle boundary:

```bash
tmux source-file ~/.tmux.conf
tmux display-message -p '#{client_theme}'
cat "${XDG_STATE_HOME:-$HOME/.local/state}/theme"
tmux show-options -gv status-style
```

Ghostty and tmux 3.7 use native mode 2031 reporting. The `client-light-theme` and `client-dark-theme` hooks make the latest valid client report the account-wide theme. `#{client_theme}` and the canonical state must each be exactly `light` or `dark`, and the status style must use the matching palette.

Change the host appearance while the direct SSH client remains attached. All three outputs should update without reconnecting or reattaching. A running Pi TUI with the signed `pi-tools` extension already loaded should switch its built-in theme within roughly 200 ms without `/reload`. `prefix+T` remains manual recovery, not the normal synchronization path.

New tmux panes inherit the updated `LC_TERMINAL_THEME`. A newly started Neovim should report the matching values:

```vim
:echo $LC_TERMINAL_THEME
:set background?
:echo g:colors_name
```

The light values are `light`, `background=light`, and `catppuccin-latte`; the dark values are `dark`, `background=dark`, and `catppuccin-mocha`.

### Verify clipboard forwarding over direct SSH

With Ghostty connected through direct SSH and tmux attached, verify clipboard integration:

```bash
tmux show-options -g set-clipboard
printf 'direct ssh clipboard test' | tmux load-buffer -w -
```

Pasting locally should produce `direct ssh clipboard test`. Neovim `<leader>y` and tmux copy-mode `y`/Enter use the same tmux OSC 52 path.

## Layout

- `dot_*`, `private_*`: files managed into `$HOME`
- `run_*`: ordered chezmoi provisioning scripts
- `.chezmoitemplates/`: shared rendered shell content
- `dot_pi/`: Pi settings and locally managed skills
- `tests/`: repository-level policy and provisioning tests
- `docs/`: focused design and implementation records
