# Dotfiles

Personal macOS and Linux dotfiles managed with [chezmoi](https://www.chezmoi.io/). The repository also contains local Pi packages, Neovim configuration, shell/tmux configuration, and machine provisioning scripts.

## Install

Clone the repository and run the canonical installer:

```bash
./install.sh
```

`bootstrap.sh` is a compatibility wrapper around `install.sh`. The installer obtains chezmoi when necessary and applies this checkout as its source. Chezmoi then installs Homebrew, packages, pinned shell plugins, Pi, and configured Pi packages.

During initialization, choose whether the machine has an Ansible-managed work zsh configuration:

- work machine: deploy `~/.personal-zshrc` and leave `~/.zshrc` unmanaged;
- personal machine: deploy `~/.zshrc` and leave `~/.personal-zshrc` unmanaged.

Repository-only directories such as `docs/`, `tests/`, `scripts/`, and `pi-*` are never deployed into `$HOME`.

## Safety

Worktrees created by `/task` use conservative cleanup. Automatic cleanup never force-removes a worktree and never deletes its branch. Clean worktrees may be safely removed; dirty worktrees and all branches are preserved for explicit recovery or cleanup.

The `/task` command is interactive and user-invoked only. It is not exposed as a model-callable tool. Agents must not use it for autonomous subagent work. If parallel work is genuinely needed and the user has not outlined a task handoff, use headless Pi agents directly.

SSH configuration is managed through one validated marker block. Unbalanced markers cause the apply step to fail without modifying the existing file.

## Pi peer messaging

The local [`pi-messaging`](pi-messaging/README.md) package lets explicitly joined Pi sessions exchange messages. A human-armed group allowance bounds automatic handoffs; agents cannot re-arm it. It requires one explicitly started, private loopback NATS broker. Loading the package alone does not start a service or opt a session into messaging.

See its README for setup, recovery limitations, and deterministic/cheap-model test commands.

## Development

Install exact development dependencies:

```bash
npm ci
```

Run validation:

```bash
npm test
npm run typecheck
npm run lint:shell
npm run check
```

`npm run check` renders JSON templates, confirms repository-only Chezmoi boundaries, and starts Neovim headlessly. It requires `chezmoi`, `jq`, and Neovim 0.12.

The authoritative Neovim plugin lockfile is `dot_config/nvim/nvim-pack-lock.json`.

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

### Verify clipboard forwarding over Mosh

Apply the updated dotfiles on both the local and remote machines. End the existing Mosh connection, reconnect normally, attach tmux, and reload its configuration:

```bash
tmux source-file ~/.tmux.conf
tmux show-options -g set-clipboard
```

Verify the active remote server is the Homebrew Mosh 1.4 binary:

```bash
pid="$(pgrep -n mosh-server)"
readlink "/proc/$pid/exe"
```

Test the transport from inside tmux:

```bash
printf 'mosh clipboard test' | tmux load-buffer -w -
```

Pasting locally should produce `mosh clipboard test`. Neovim `<leader>y` and tmux copy-mode `y`/Enter use the same OSC 52 path.

## Layout

- `dot_*`, `private_*`: files managed into `$HOME`
- `run_*`: ordered chezmoi provisioning scripts
- `.chezmoitemplates/`: shared rendered shell content
- `pi-*`: local Pi packages loaded from the chezmoi source directory
- `tests/`: repository-level policy and provisioning tests
- `docs/superpowers/`: implementation designs and plans
