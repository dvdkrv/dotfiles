#!/usr/bin/env bash
set -uo pipefail

MOSH_BIN="${MOSH_AGENT_MOSH_BIN:-$(command -v mosh || true)}"
SSH_BIN="${MOSH_AGENT_SSH_BIN:-$(command -v ssh || true)}"
READY_TIMEOUT="${MOSH_AGENT_READY_TIMEOUT:-10}"
RETRY_INITIAL="${MOSH_AGENT_RETRY_INITIAL:-1}"
RETRY_MAX="${MOSH_AGENT_RETRY_MAX:-15}"
POLL_INTERVAL="${MOSH_AGENT_POLL_INTERVAL:-0.2}"
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
[[ "$RETRY_INITIAL" =~ ^[0-9]+$ ]] || fail "MOSH_AGENT_RETRY_INITIAL must be a non-negative integer"
[[ "$RETRY_MAX" =~ ^[0-9]+$ ]] || fail "MOSH_AGENT_RETRY_MAX must be a non-negative integer"
((RETRY_INITIAL <= RETRY_MAX)) || fail "MOSH_AGENT_RETRY_INITIAL must not exceed MOSH_AGENT_RETRY_MAX"
[[ "$POLL_INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "MOSH_AGENT_POLL_INTERVAL must be numeric"

ready_file="$(mktemp "${TMPDIR:-/tmp}/mosh-agent-ready.XXXXXX")" || fail "could not create readiness file"
diagnostic_file="$(mktemp "${TMPDIR:-/tmp}/mosh-agent-diagnostic.XXXXXX")" || {
  rm -f "$ready_file"
  fail "could not create diagnostic file"
}
sidecar_pid=""
mosh_pid=""
last_sidecar_reason=""

process_is_running() {
  [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null
}

stop_sidecar() {
  local pid="$sidecar_pid"
  [[ -n "$pid" ]] || return 0

  sidecar_pid=""
  if process_is_running "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local pid

  pid="$mosh_pid"
  mosh_pid=""
  if [[ -n "$pid" ]]; then
    if process_is_running "$pid"; then
      kill "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  fi

  stop_sidecar
  rm -f "$ready_file" "$diagnostic_file"
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

start_sidecar() {
  local deadline
  local status

  : >"$ready_file"
  : >"$diagnostic_file"
  last_sidecar_reason=""

  "$SSH_BIN" \
    -A -T \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -- "$destination" "$remote_command" \
    >"$ready_file" 2>"$diagnostic_file" &
  sidecar_pid=$!
  deadline=$((SECONDS + READY_TIMEOUT))

  while ! grep -Fxq "$READY_MARKER" "$ready_file" 2>/dev/null; do
    if [[ -n "$mosh_pid" ]] && ! process_is_running "$mosh_pid"; then
      last_sidecar_reason="Mosh exited during sidecar startup"
      stop_sidecar
      return 2
    fi
    if ! process_is_running "$sidecar_pid"; then
      wait "$sidecar_pid" 2>/dev/null
      status=$?
      sidecar_pid=""
      last_sidecar_reason="exited before readiness (status $status)"
      return 1
    fi
    if ((SECONDS >= deadline)); then
      last_sidecar_reason="did not become ready within ${READY_TIMEOUT}s"
      stop_sidecar
      return 1
    fi
    sleep "$POLL_INTERVAL"
  done

  if ! process_is_running "$sidecar_pid"; then
    wait "$sidecar_pid" 2>/dev/null
    status=$?
    sidecar_pid=""
    last_sidecar_reason="exited after readiness (status $status)"
    return 1
  fi

  return 0
}

wait_for_retry() {
  local delay="$1"
  local deadline=$((SECONDS + delay))

  while ((SECONDS < deadline)); do
    process_is_running "$mosh_pid" || return 1
    sleep "$POLL_INTERVAL"
  done
  process_is_running "$mosh_pid"
}

if ! start_sidecar; then
  [[ ! -s "$diagnostic_file" ]] || cat "$diagnostic_file" >&2
  fail "SSH agent sidecar failed: $last_sidecar_reason"
fi

"$MOSH_BIN" "$@" &
mosh_pid=$!
retry_delay=$RETRY_INITIAL

while process_is_running "$mosh_pid"; do
  if process_is_running "$sidecar_pid"; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  if [[ -n "$sidecar_pid" ]]; then
    wait "$sidecar_pid" 2>/dev/null || true
    sidecar_pid=""
  fi

  if start_sidecar; then
    retry_delay=$RETRY_INITIAL
    continue
  fi

  process_is_running "$mosh_pid" || break
  wait_for_retry "$retry_delay" || break
  if ((retry_delay < RETRY_MAX)); then
    retry_delay=$((retry_delay * 2))
    if ((retry_delay > RETRY_MAX)); then
      retry_delay=$RETRY_MAX
    fi
  fi
done

wait "$mosh_pid"
mosh_status=$?
mosh_pid=""
exit "$mosh_status"
