# Pi automatic light/dark theme design

Date: 2026-09-14
Status: Approved for implementation planning
Branch: `fix/pi-auto-theme`

## Problem

Some long-running Pi sessions render user prompts with the built-in dark background even though the attached terminal uses a light appearance. The discrepancy is process-local rather than conversation-specific.

The managed global Pi settings contain no `theme` value. Every inspected Pi process has `TERM=tmux-256color` and `COLORTERM=truecolor`, but no `COLORFGBG`. Pi therefore initializes each process with its low-confidence dark fallback. With no explicit theme setting, Pi performs a one-time 100 ms OSC 11 background query during interactive startup. A session whose query times out remains dark; a successful query can select light. The inspected processes span different Pi versions and startup conditions, but none has an environment fallback and the current global setting still does not request ongoing automatic synchronization. This accounts for process-local disagreement, with the user-message background as the conspicuous symptom.

## Selected behavior

Configure Pi's built-in automatic theme pair explicitly:

```json
{
  "theme": "light/dark"
}
```

Pi interprets the slash form as `lightTheme/darkTheme`, selects the built-in `light` theme for a light terminal and `dark` for a dark terminal, and enables terminal color-scheme notifications. This preserves automatic switching rather than forcing all sessions to one appearance or overriding only one color token.

The selected approach uses public Pi settings and built-in themes. It adds no extension, custom theme, polling loop, terminal escape implementation, or dependency.

## Configuration and rollout

Add the setting to `dot_pi/agent/settings.json.tmpl`, the chezmoi-managed source for the global Pi settings. Apply that one managed target to the current local Pi settings only after tests pass. Do not alter saved conversations, active session histories, extensions, tools, loops, or messaging participation.

Existing Pi processes do not need to be killed. The human can run `/reload` at a safe idle boundary in each affected session; Pi reloads settings, reapplies the theme controller, rebuilds the chat rendering, queries terminal appearance, and enables automatic color-scheme notifications. Starting a new Pi process also picks up the setting. Reload timing remains human-controlled.

If the terminal and tmux path support neither the color-scheme query/notification protocol nor OSC 11, Pi can still fall back to dark because no reliable appearance signal exists. This change uses the intended automatic mechanism; it does not hard-code `COLORFGBG` or claim detection can succeed through every terminal multiplexer.

## Testing

Add a repository regression test that parses `dot_pi/agent/settings.json.tmpl` and asserts the exact value `light/dark`. This prevents removal of explicit automatic mode while allowing built-in theme implementation details to remain Pi-owned.

Run the focused settings test, aggregate repository tests, TypeScript, ShellCheck, repository checks, and whitespace checks. Validate the rendered chezmoi target before applying it. Do not automate a live TUI color assertion: it would depend on a terminal answering OSC queries and would not reliably test the managed configuration.

## Non-goals

- Forcing the built-in light theme everywhere.
- Creating or maintaining a custom color palette.
- Changing only `userMessageBg` while leaving an incorrectly detected dark theme active.
- Restarting or reloading active Pi sessions automatically.
- Modifying tmux, Ghostty, saved session data, or Pi's upstream theme-detection code.
