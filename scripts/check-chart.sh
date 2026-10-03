#!/usr/bin/env bash
# Checks the Helm chart without a cluster: helm lint --strict and helm template for every fixture
# in tests/helm/fixtures/ (each on top of the base fixtures/values.yaml), and expected failures for
# every fixture in tests/helm/fixtures/invalid/. An invalid fixture names the message it must fail
# with: "# expect-schema: <text>" from values.schema.json, "# expect: <text>" from the templates
# (checked with --skip-schema-validation, so the templates' own checks are tested as well).
# Runs every check and exits 1 when any result was unexpected. Never talks to a cluster.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHART="$ROOT/charts/wire-support-bot"
FIXTURES="$ROOT/tests/helm/fixtures"
BASE="$FIXTURES/values.yaml"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

failed=0
fail() {
  echo "FAIL: $*" >&2
  failed=1
}

for fixture in "$FIXTURES"/*.yaml; do
  [ "$fixture" = "$BASE" ] && continue
  name="$(basename "$fixture")"
  if ! helm lint "$CHART" --strict -f "$BASE" -f "$fixture" >"$OUT" 2>&1; then
    cat "$OUT" >&2
    fail "helm lint --strict with $name"
    continue
  fi
  if ! helm template wire-support-bot "$CHART" -f "$BASE" -f "$fixture" >"$OUT" 2>&1; then
    cat "$OUT" >&2
    fail "helm template with $name"
    continue
  fi
  echo "ok: $name"
done

# Runs helm template with the arguments after the first, which must fail with the message given
# as the first argument.
expect_failure() {
  local message="$1" label="$2"
  shift 2
  if helm template wire-support-bot "$CHART" "$@" >"$OUT" 2>&1; then
    fail "$label rendered, but must fail with: $message"
  elif ! grep -qF -- "$message" "$OUT"; then
    cat "$OUT" >&2
    fail "$label failed without the message: $message"
  else
    echo "ok: $label fails as expected"
  fi
}

for fixture in "$FIXTURES"/invalid/*.yaml; do
  name="invalid/$(basename "$fixture")"
  schema="$(sed -n 's/^# expect-schema: //p' "$fixture")"
  template="$(sed -n 's/^# expect: //p' "$fixture")"
  if [ -z "$schema" ] && [ -z "$template" ]; then
    fail "$name names no expected message (# expect: or # expect-schema:)"
    continue
  fi
  if [ -n "$schema" ]; then
    expect_failure "$schema" "$name (schema)" -f "$BASE" -f "$fixture"
  fi
  if [ -n "$template" ]; then
    expect_failure "$template" "$name (template)" --skip-schema-validation -f "$BASE" -f "$fixture"
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "Chart checks failed." >&2
  exit 1
fi
echo "Chart checks passed."
