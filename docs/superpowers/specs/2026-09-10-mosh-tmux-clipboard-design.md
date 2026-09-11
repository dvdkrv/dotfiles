# Mosh and tmux Clipboard Compatibility Design

## Goal

Make Neovim and tmux copy-mode selections reach the local system clipboard through a Mosh connection without changing local or non-Mosh clipboard behavior.

## Root Cause

Neovim correctly detects tmux as its clipboard provider and writes selections with `tmux load-buffer -w`. tmux has `set-clipboard on` and an `Ms` capability, but for this operation it emits OSC 52 with an empty clipboard selector:

```text
ESC ] 52 ; ; <base64 payload> BEL
```

Mosh 1.4 only recognizes OSC 52 when the selector is `c`:

```text
ESC ] 52 ; c ; <base64 payload> BEL
```

Mosh therefore discards tmux's sequence before Ghostty can update the local clipboard. The same selector mismatch affects tmux copy mode.

A second startup issue can select `/usr/bin/mosh-server` 1.3.2 because Mosh launches the remote server before interactive shell initialization adds Homebrew to `PATH`. Mosh 1.3.2 does not support OSC 52 at all.

## Design

### tmux OSC 52 capability

Add an `Ms` terminal capability override for `xterm-256color`, the terminal type exposed to tmux through Mosh. The terminfo expression will preserve a non-empty selector and substitute `c` only when tmux supplies an empty selector:

```tmux
set -as terminal-overrides ',xterm-256color:Ms=\E]52;%?%p1%l%t%p1%s%ec%;;%p2%s\007'
```

The override is scoped to `xterm-256color`, so direct local Ghostty sessions continue using Ghostty's native terminal capabilities. Existing `set-clipboard on`, Neovim mappings, and tmux copy-mode bindings remain unchanged.

### Mosh server selection

For trusted `workspace-*` destinations, `mosh-with-agent.sh` will provide a default remote server command that prepends standard Homebrew binary locations to the remote `PATH`. This makes the already-provisioned Mosh 1.4 server discoverable before shell startup while retaining the system `PATH` as a fallback.

If the caller supplies `--server COMMAND` or `--server=COMMAND`, the wrapper will not add its default. Non-workspace destinations remain pass-through and unchanged.

## Validation

- Extend Mosh helper tests to verify the default server command is added only for workspace connections and explicit server commands are preserved.
- Validate that tmux parses the OSC 52 capability override into its effective server options.
- Run an isolated pseudo-terminal capture and confirm tmux emits `ESC ] 52 ; c ; ... BEL`.
- Run the complete repository tests, typecheck, shell lint, and repository checks.
- Document that existing Mosh connections must reconnect and existing tmux servers must reload `~/.tmux.conf`.
