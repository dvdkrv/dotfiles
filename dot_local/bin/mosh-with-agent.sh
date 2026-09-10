#!/usr/bin/env bash
set -uo pipefail

MOSH_BIN="${MOSH_AGENT_MOSH_BIN:-$(command -v mosh || true)}"
SSH_BIN="${MOSH_AGENT_SSH_BIN:-$(command -v ssh || true)}"
READY_TIMEOUT="${MOSH_AGENT_READY_TIMEOUT:-10}"
READY_MARKER="__MOSH_AGENT_READY__"

fail() {
  printf 'mosh: %s\n' "$*" >&2
  exit 1
}

[[ -n "$MOSH_BIN" && -x "$MOSH_BIN" ]] || fail "external mosh executable not found"

find_destination() {
  local argument
  local options_ended=0
  local skip_value=0

  for argument in "$@"; do
    if ((skip_value)); then
      skip_value=0
      continue
    fi

    if ((options_ended)); then
      printf '%s\n' "$argument"
      return 0
    fi

    case "$argument" in
      --)
        options_ended=1
        ;;
      -p | --client | --server | --predict | --family | --port | --bind-server | --ssh | --experimental-remote-ip)
        skip_value=1
        ;;
      --client=* | --server=* | --predict=* | --family=* | --port=* | --bind-server=* | --ssh=* | --experimental-remote-ip=*)
        ;;
      -4 | -6 | -a | -n | --no-ssh-pty | --no-init)
        ;;
      --help | --version | --local)
        return 1
        ;;
      -*)
        return 1
        ;;
      *)
        printf '%s\n' "$argument"
        return 0
        ;;
    esac
  done

  return 1
}

destination="$(find_destination "$@" || true)"
host="${destination##*@}"

if [[ -z "$destination" || "$host" != workspace-* ]]; then
  exec "$MOSH_BIN" "$@"
fi

[[ -n "$SSH_BIN" && -x "$SSH_BIN" ]] || fail "ssh executable not found for workspace agent forwarding"
[[ -n "${SSH_AUTH_SOCK:-}" ]] || fail "SSH_AUTH_SOCK is unset; start a local SSH agent before connecting"
[[ "$READY_TIMEOUT" =~ ^[0-9]+$ ]] || fail "MOSH_AGENT_READY_TIMEOUT must be a non-negative integer"

ready_file="$(mktemp "${TMPDIR:-/tmp}/mosh-agent-ready.XXXXXX")" || fail "could not create readiness file"
sidecar_pid=""
mosh_pid=""

cleanup() {
  if [[ -n "$mosh_pid" ]] && kill -0 "$mosh_pid" 2>/dev/null; then
    kill "$mosh_pid" 2>/dev/null || true
    wait "$mosh_pid" 2>/dev/null || true
  fi
  if [[ -n "$sidecar_pid" ]] && kill -0 "$sidecar_pid" 2>/dev/null; then
    kill "$sidecar_pid" 2>/dev/null || true
    wait "$sidecar_pid" 2>/dev/null || true
  fi
  rm -f "$ready_file"
}

on_exit() {
  local status=$?
  trap - EXIT INT TERM HUP
  cleanup
  exit "$status"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

remote_command=$(cat <<'REMOTE_COMMAND'
set -eu

if [ -z "${SSH_AUTH_SOCK:-}" ]; then
  echo "forwarded SSH_AUTH_SOCK is unavailable" >&2
  exit 1
fi

stable_socket="$HOME/.ssh/ssh_auth_sock"
temporary_link="${stable_socket}.mosh-agent.$$"
mkdir -p "$HOME/.ssh"

cleanup_link() {
  current_target=$(readlink "$stable_socket" 2>/dev/null || true)
  if [ "$current_target" = "$SSH_AUTH_SOCK" ]; then
    rm -f "$stable_socket"
  fi
  rm -f "$temporary_link"
}

trap 'cleanup_link; exit 0' HUP INT TERM
trap cleanup_link EXIT

rm -f "$temporary_link"
ln -s "$SSH_AUTH_SOCK" "$temporary_link"
mv -f "$temporary_link" "$stable_socket"
printf '%s\n' '__MOSH_AGENT_READY__'

while :; do
  sleep 3600 &
  wait "$!"
done
REMOTE_COMMAND
)

"$SSH_BIN" -A -T -o BatchMode=yes -- "$destination" "$remote_command" >"$ready_file" &
sidecar_pid=$!
deadline=$((SECONDS + READY_TIMEOUT))

while ! grep -Fxq "$READY_MARKER" "$ready_file" 2>/dev/null; do
  if ! kill -0 "$sidecar_pid" 2>/dev/null; then
    wait "$sidecar_pid" 2>/dev/null
    sidecar_status=$?
    sidecar_pid=""
    fail "SSH agent sidecar failed before readiness (status $sidecar_status)"
  fi
  if ((SECONDS >= deadline)); then
    fail "SSH agent sidecar did not become ready within ${READY_TIMEOUT}s"
  fi
  sleep 0.05
done

if ! kill -0 "$sidecar_pid" 2>/dev/null; then
  wait "$sidecar_pid" 2>/dev/null
  sidecar_status=$?
  sidecar_pid=""
  fail "SSH agent sidecar exited after readiness (status $sidecar_status)"
fi

"$MOSH_BIN" "$@" &
mosh_pid=$!
wait "$mosh_pid"
mosh_status=$?
mosh_pid=""
exit "$mosh_status"
