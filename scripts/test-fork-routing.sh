#!/bin/sh
set -eu
cd "$(dirname "$0")/../tests"
run_suites() {
  for suite do
    [ -f "$suite" ] || { printf 'Missing routing suite: %s\n' "$suite" >&2; exit 1; }
  done
  exec ./node_modules/.bin/vitest run "$@"
}

run_suites \
  unit/combo-routing.test.js \
  unit/combo-request-scoped-fallback.test.js \
  unit/account-fallback-4xx.test.js \
  unit/codex-auto-review-routing.test.js \
  unit/codex-compact-routing.test.js \
  unit/model-routing.test.js \
  unit/codex-fast-capacity.test.js \
  unit/base-executor-retry.test.js \
  unit/codex-native-passthrough-thinking.test.js \
  unit/api-key-fast-mode.test.js \
  unit/openai-api-provider.test.js \
  unit/chat-client-disconnect.test.js \
  unit/request-speed.test.js \
  unit/request-trace-stream.test.js \
  unit/routing-health.test.js \
  unit/custom-server-request-diagnostics.test.js "$@"
