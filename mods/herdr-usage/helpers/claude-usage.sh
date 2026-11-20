#!/bin/sh
# Ask the user's own claude CLI for its usage, so the mod reads no token. Adapted from
# nozikov/herdr-usage-limits (MIT). No prompt is sent and no turn is started; --safe-mode keeps hooks,
# MCP servers and customizations out of that run.
NOT_INSTALLED=127
NO_REPLY=1
WAIT_ROUNDS=75
REQUEST='{"type":"control_request","request_id":"herdr-usage","request":{"subtype":"get_usage","skip_behaviors":true}}'

CLAUDE=$(command -v "${HERDR_USAGE_CLAUDE_BIN:-claude}" 2>/dev/null) || exit "$NOT_INSTALLED"

dir=$(mktemp -d "${TMPDIR:-/tmp}/herdr-claude-usage.XXXXXX") || exit "$NO_REPLY"
out="$dir/out"

ask_with_the_request_in_a_regular_file() {
  printf '%s\n' "$REQUEST" >"$dir/in"
  "$CLAUDE" -p --safe-mode --no-session-persistence \
    --input-format stream-json --output-format stream-json --verbose \
    <"$dir/in" >"$out" 2>/dev/null &
}

ask_with_the_request_in_a_regular_file
pid=$!

i=0
while [ "$i" -lt "$WAIT_ROUNDS" ]; do
  if grep -q '"control_response"' "$out" 2>/dev/null; then break; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
  i=$((i + 1))
done
kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null

status=$NO_REPLY
if grep -m1 '"control_response"' "$out"; then status=0; fi
rm -rf "$dir"
exit "$status"
