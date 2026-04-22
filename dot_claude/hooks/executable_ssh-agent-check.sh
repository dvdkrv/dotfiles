#!/usr/bin/env bash
# Hook: detect SSH agent errors in failed Bash commands and prompt Claude to run ssh -T git@github.com

input=$(cat)
output=$(echo "$input" | jq -r '.tool_response.output // ""')

if echo "$output" | grep -qE \
  "(Could not read from remote repository|Permission denied.{0,20}publickey|ssh_askpass|ERROR: Repository not found|could not connect to agent|Could not connect to your SSH agent|Error: could not connect)"; then
  printf '{"hookSpecificOutput": {"hookEventName": "PostToolUseFailure", "additionalContext": "SSH agent error detected in the command output. Run: ssh -T git@github.com to test the SSH connection and diagnose the issue."}}\n'
fi
