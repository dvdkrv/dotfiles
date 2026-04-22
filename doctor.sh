#!/usr/bin/env bash
# doctor.sh — quick health check for this dotfiles setup on the current machine.

set -u

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

pass=0
fail=0

ok()   { printf "%sok%s   %s\n" "$GREEN" "$RESET" "$1"; pass=$((pass+1)); }
bad()  { printf "%sFAIL%s %s\n" "$RED"   "$RESET" "$1"; fail=$((fail+1)); }
warn() { printf "%swarn%s %s\n" "$YELLOW" "$RESET" "$1"; }

check_cmd() {
    if command -v "$1" >/dev/null 2>&1; then
        ok "$1 found ($(command -v "$1"))"
    else
        bad "$1 not in PATH"
    fi
}

printf "== commands ==\n"
for c in chezmoi brew starship zoxide fzf nvim jq; do
    check_cmd "$c"
done

printf "\n== chezmoi doctor ==\n"
if command -v chezmoi >/dev/null 2>&1; then
    chezmoi doctor || warn "chezmoi doctor reported issues"
else
    bad "chezmoi not installed — skipping chezmoi doctor"
fi

printf "\n== claude hooks ==\n"
if [[ -x "$HOME/.claude/hooks/ssh-agent-check.sh" ]]; then
    ok "~/.claude/hooks/ssh-agent-check.sh is executable"
else
    bad "~/.claude/hooks/ssh-agent-check.sh missing or not executable"
fi

printf "\n== ssh agent ==\n"
sock="$HOME/.ssh/ssh_auth_sock"
if [[ -L "$sock" ]]; then
    target=$(readlink "$sock")
    if [[ -S "$target" ]]; then
        ok "SSH auth sock symlink resolves to a live socket ($target)"
    else
        bad "SSH auth sock symlink target is not a socket ($target)"
    fi
elif [[ -S "$sock" ]]; then
    ok "SSH auth sock exists (not a symlink)"
else
    warn "no ~/.ssh/ssh_auth_sock — ok if you don't use SSH on this host"
fi

printf "\n== json templates render ==\n"
if command -v chezmoi >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    repo=$(cd "$(dirname "$0")" && pwd)
    any=0
    for f in "$repo"/dot_claude/*.json.tmpl "$repo"/dot_claude/**/*.json.tmpl; do
        [[ -e "$f" ]] || continue
        any=1
        if chezmoi execute-template < "$f" | jq -e . >/dev/null 2>&1; then
            ok "renders: ${f#$repo/}"
        else
            bad "broken:  ${f#$repo/}"
        fi
    done
    [[ $any -eq 0 ]] && warn "no dot_claude/**/*.json.tmpl files found"
else
    warn "chezmoi or jq missing — skipping template render checks"
fi

printf "\n== summary ==\n"
printf "%d passed, %d failed\n" "$pass" "$fail"
[[ $fail -eq 0 ]] || exit 1
