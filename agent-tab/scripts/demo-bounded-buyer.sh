#!/usr/bin/env bash
#
# Bounded-buyer demo runner — check-only.
#
# Assumes Ergo node, ChainCash sidecar, and Agent Tab are already running.
# Verifies each, then seeds the authority fixture and runs the OpenClaw
# caller end-to-end. Does NOT start, stop, or manage any process itself.
#
# Usage:
#   bash agent-tab/scripts/demo-bounded-buyer.sh
#
# Exits non-zero with start-instructions if any required service is down.

set -euo pipefail

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
DIM=$'\033[2m'
RESET=$'\033[0m'

step() { printf '\n→ %s\n' "$1"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
hint() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }

# Probe an HTTP endpoint. On failure, print a remediation hint.
# Returns 0 on success, 1 on failure (collected by the caller; does not exit).
check_http() {
  local label="$1"
  local url="$2"
  local start_cmd="$3"
  if curl --silent --fail --show-error --connect-timeout 2 --max-time 5 \
       --output /dev/null "$url"; then
    ok "$label reachable at $url"
    return 0
  fi
  bad "$label is not reachable at $url"
  hint "Start it with:"
  hint "  $start_cmd"
  return 1
}

main() {
  # Resolve repo paths from script location so the runner works regardless
  # of the user's current working directory.
  local script_dir agent_tab_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  agent_tab_dir="$(dirname "$script_dir")"
  cd "$agent_tab_dir"

  printf '==========================================\n'
  printf '  Bounded-buyer demo runner (check-only)\n'
  printf '==========================================\n'

  step "Preflight — checking required services"

  local errors=0
  check_http "Ergo testnet node" \
    "http://localhost:9052/info" \
    "cd ~/ergo && java -jar ergo-5.0.14.jar --testnet -c ergo.conf" \
    || errors=$((errors + 1))

  check_http "ChainCash sidecar" \
    "http://localhost:8081/health" \
    "cd chaincash && sbt \"runMain chaincash.sidecar.SidecarServer\"" \
    || errors=$((errors + 1))

  check_http "Agent Tab (Next.js)" \
    "http://localhost:3000/" \
    "cd agent-tab && DEMO_MODE=true npx next dev -p 3000" \
    || errors=$((errors + 1))

  if [ "$errors" -gt 0 ]; then
    printf '\n%sPreflight failed — start the missing service(s) and re-run.%s\n' \
      "$RED" "$RESET"
    printf '%sNote: this script does not start services on your behalf.%s\n' \
      "$DIM" "$RESET"
    printf '%sIf the Ergo wallet is locked, also run:%s\n' "$DIM" "$RESET"
    printf "%s  curl -X POST http://localhost:9052/wallet/unlock \\\\%s\n" "$DIM" "$RESET"
    printf '%s    -H "api_key: hello" -H "Content-Type: application/json" \\%s\n' "$DIM" "$RESET"
    printf "%s    -d '{\"pass\":\"hello\"}'%s\n" "$DIM" "$RESET"
    exit 1
  fi

  step "Seeding the bounded-buyer fixture (scripts/seed-authority-demo.ts)"
  npx tsx scripts/seed-authority-demo.ts

  step "Running the OpenClaw caller end-to-end (mode=demo)"
  npx tsx scripts/openclaw-caller.ts --mode=demo

  printf '\n==========================================\n'
  printf '  Demo complete\n'
  printf '==========================================\n'
  printf '\n  Open the operator pool view:\n\n'
  printf '    %shttp://localhost:3000/pool/auth-demo-reserve-001%s\n' \
    "$YELLOW" "$RESET"
  printf '\n  Refresh the page and verify:\n'
  printf '    [ ] A new agent-bound delegation appears in Agent Authority\n'
  printf '    [ ] Recent Agent Activity shows one %sCharged%s row\n' \
    "$GREEN" "$RESET"
  printf '    [ ] Recent Agent Activity shows one %sDenied%s row\n' \
    "$RED" "$RESET"
  printf '    [ ] The denied call did not move spentSoFar or any obligation balance\n\n'
}

main "$@"
