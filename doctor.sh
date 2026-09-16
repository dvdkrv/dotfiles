#!/usr/bin/env bash
# doctor.sh — read-only health check for this dotfiles setup on the current machine.

set -u

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

EXPECTED_PI_VERSION="0.84.1"
EXPECTED_PI_TOOLS="git:git@github.com:dvdkrv/pi-tools.git@v0.1.1"
EXPECTED_SUPERPOWERS="git:github.com/obra/superpowers@v6.2.0"
MIN_NODE_VERSION="22.19.0"
MIN_NATS_VERSION="2.14.6"

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

version_at_least() {
    awk -v actual="$1" -v minimum="$2" 'BEGIN {
        actual_count = split(actual, actual_parts, ".")
        minimum_count = split(minimum, minimum_parts, ".")
        count = actual_count > minimum_count ? actual_count : minimum_count
        for (i = 1; i <= count; i++) {
            actual_part = (i <= actual_count ? actual_parts[i] : 0) + 0
            minimum_part = (i <= minimum_count ? minimum_parts[i] : 0) + 0
            if (actual_part > minimum_part) exit 0
            if (actual_part < minimum_part) exit 1
        }
        exit 0
    }'
}

mode_of() {
    if [[ "$(uname -s)" == "Darwin" ]]; then
        stat -f '%Lp' "$1"
    else
        stat -c '%a' "$1"
    fi
}

check_mode() {
    local path="$1"
    local expected="$2"
    local label="$3"
    local actual

    if [[ ! -e "$path" ]]; then
        bad "$label is missing"
        return
    fi
    if ! actual="$(mode_of "$path" 2>/dev/null)"; then
        bad "$label permissions could not be inspected"
    elif [[ "$actual" == "$expected" ]]; then
        ok "$label has mode 0$expected"
    else
        bad "$label must have mode 0$expected (found 0$actual)"
    fi
}

printf "== commands ==\n"
for command in chezmoi brew starship zoxide fzf nvim jq node npm pi nats-server mosh tmux git; do
    check_cmd "$command"
done

printf "\n== reviewed versions ==\n"
if command -v node >/dev/null 2>&1; then
    node_output="$(node --version 2>/dev/null || true)"
    node_version="${node_output#v}"
    if [[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && version_at_least "$node_version" "$MIN_NODE_VERSION"; then
        ok "Node $node_version satisfies minimum $MIN_NODE_VERSION"
    else
        bad "Node must be at least $MIN_NODE_VERSION (found ${node_output:-unknown})"
    fi
fi

if command -v pi >/dev/null 2>&1; then
    pi_version="$(pi --version 2>/dev/null || true)"
    if [[ "$pi_version" == "$EXPECTED_PI_VERSION" ]]; then
        ok "Pi $pi_version matches reviewed version $EXPECTED_PI_VERSION"
    else
        bad "Pi must equal reviewed version $EXPECTED_PI_VERSION (found ${pi_version:-unknown})"
    fi
fi

if command -v nats-server >/dev/null 2>&1; then
    nats_output="$(nats-server --version 2>/dev/null || true)"
    nats_version="$(sed -nE 's/.*v([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' <<<"$nats_output")"
    if [[ ! "$nats_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        bad "NATS version could not be parsed"
    elif [[ "${nats_version%%.*}" != "2" ]]; then
        bad "NATS major version must remain 2 (found $nats_version)"
    elif version_at_least "$nats_version" "$MIN_NATS_VERSION"; then
        ok "NATS $nats_version satisfies 2.x minimum $MIN_NATS_VERSION"
    else
        bad "NATS must be at least $MIN_NATS_VERSION (found $nats_version)"
    fi
fi

printf "\n== Pi packages ==\n"
if command -v pi >/dev/null 2>&1; then
    if pi_packages="$(pi list 2>/dev/null)"; then
        pi_tools_count="$(grep -Fc -- "$EXPECTED_PI_TOOLS" <<<"$pi_packages")"
        superpowers_count="$(grep -Fc -- "$EXPECTED_SUPERPOWERS" <<<"$pi_packages")"
        if [[ "$pi_tools_count" == "1" ]]; then
            ok "pi-tools v0.1.1 is configured exactly once"
        else
            bad "pi-tools v0.1.1 must be configured exactly once"
        fi
        if [[ "$superpowers_count" == "1" ]]; then
            ok "Superpowers v6.2.0 is configured exactly once"
        else
            bad "Superpowers v6.2.0 must be configured exactly once"
        fi
        unset pi_packages
    else
        bad "Pi package metadata could not be listed"
    fi
fi

printf "\n== chezmoi doctor ==\n"
if command -v chezmoi >/dev/null 2>&1; then
    chezmoi doctor || warn "chezmoi doctor reported issues"
else
    bad "chezmoi not installed — skipping chezmoi doctor"
fi

printf "\n== SSH configuration ==\n"
ssh_dir="$HOME/.ssh"
ssh_config="$ssh_dir/config"
ssh_managed="$ssh_dir/config_chezmoi"
check_mode "$ssh_dir" 700 "SSH directory"
check_mode "$ssh_config" 600 "SSH config"
check_mode "$ssh_managed" 600 "SSH managed config"
if [[ -f "$ssh_config" ]]; then
    if awk '
        $0 == "## BEGIN -- chezmoi" {
            begins++
            if (in_block) invalid=1
            in_block=1
            next
        }
        $0 == "## END -- chezmoi" {
            ends++
            if (!in_block) invalid=1
            in_block=0
            next
        }
        END { exit(invalid || in_block || begins != 1 || ends != 1 ? 1 : 0) }
    ' "$ssh_config" && [[ "$(grep -Fxc 'Include ~/.ssh/config_chezmoi' "$ssh_config")" == "1" ]]; then
        ok "SSH managed marker block is balanced and unique"
    else
        bad "SSH managed marker block is invalid"
    fi
fi

printf "\n== claude hooks ==\n"
if [[ -x "$HOME/.claude/hooks/ssh-agent-check.sh" ]]; then
    ok "$HOME/.claude/hooks/ssh-agent-check.sh is executable"
else
    bad "$HOME/.claude/hooks/ssh-agent-check.sh missing or not executable"
fi

printf "\n== ssh agent ==\n"
sock="$HOME/.ssh/ssh_auth_sock"
if [[ -L "$sock" ]]; then
    target="$(readlink "$sock")"
    if [[ -S "$target" ]]; then
        ok "SSH auth sock symlink resolves to a live socket"
    else
        bad "SSH auth sock symlink target is not a socket"
    fi
elif [[ -S "$sock" ]]; then
    ok "SSH auth sock exists"
else
    warn "no ~/.ssh/ssh_auth_sock — ok if you do not use SSH on this host"
fi

printf "\n== terminal theme state ==\n"
theme_file="${XDG_STATE_HOME:-$HOME/.local/state}/theme"
if [[ ! -e "$theme_file" ]]; then
    warn "theme state is absent; it will be initialized by terminal integration"
elif [[ ! -f "$theme_file" ]]; then
    bad "theme state must be a regular file"
else
    theme="$(tr -d '\r\n' < "$theme_file")"
    if [[ "$theme" == "light" || "$theme" == "dark" ]]; then
        ok "theme state is $theme"
    else
        bad "theme state must contain exactly light or dark"
    fi
fi

printf "\n== messaging runtime ==\n"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
messaging_dir="$agent_dir/messaging"
if [[ ! -e "$messaging_dir" ]]; then
    warn "messaging broker is not initialized; messaging directory is absent"
elif [[ ! -d "$messaging_dir" ]]; then
    bad "messaging path must be a directory"
else
    check_mode "$messaging_dir" 700 "messaging directory"
    if [[ -e "$messaging_dir/data" ]]; then
        check_mode "$messaging_dir/data" 700 "messaging data directory"
    fi
    for lifecycle_file in config.json server.json broker-process.json broker.log startup.lock; do
        if [[ -e "$messaging_dir/$lifecycle_file" ]]; then
            check_mode "$messaging_dir/$lifecycle_file" 600 "messaging $lifecycle_file"
        fi
    done

    broker_record="$messaging_dir/broker-process.json"
    if [[ ! -e "$broker_record" ]]; then
        warn "messaging broker is not initialized; broker metadata is absent"
    elif command -v jq >/dev/null 2>&1; then
        if broker_pid="$(jq -er '.pid | select(type == "number" and . == floor and . > 0)' "$broker_record" 2>/dev/null)"; then
            if kill -0 "$broker_pid" 2>/dev/null; then
                ok "messaging broker process is running"
            else
                warn "messaging broker metadata is valid but its process is not running"
            fi
        else
            bad "messaging broker metadata is malformed"
        fi
    fi
fi

printf "\n== json templates render ==\n"
if command -v chezmoi >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    repo="$(cd "$(dirname "$0")" && pwd)"
    any=0
    for file in "$repo"/dot_claude/*.json.tmpl "$repo"/dot_claude/**/*.json.tmpl "$repo"/dot_pi/**/*.json.tmpl; do
        [[ -e "$file" ]] || continue
        any=1
        if chezmoi execute-template < "$file" | jq -e . >/dev/null 2>&1; then
            ok "renders: ${file#"$repo"/}"
        else
            bad "broken:  ${file#"$repo"/}"
        fi
    done
    [[ $any -eq 0 ]] && warn "no JSON templates found"
else
    warn "chezmoi or jq missing — skipping template render checks"
fi

printf "\n== summary ==\n"
printf "%d passed, %d failed\n" "$pass" "$fail"
[[ $fail -eq 0 ]] || exit 1
