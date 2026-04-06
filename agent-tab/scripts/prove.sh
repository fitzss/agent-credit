#!/bin/bash
# Unified proof stack — runs all regression suites.
#
# Usage: cd agent-tab && bash scripts/prove.sh
#
# Suites:
#   1. Settlement substrate (validate.sh)        — 12 checks
#   2. Authority loop (test-authority-loop.ts)    — 6 checks  (requires authority-demo fixture)
#   3. Authority guardrails (test-authority-guardrails.ts) — 10 checks (requires authority-demo fixture)
#
# Authority tests are skipped if the fixture is not seeded.
# Seed it with: npx tsx scripts/seed-authority-demo.ts

set -uo pipefail

AGENT="http://localhost:3000"
SIDECAR="http://localhost:8081"

SETTLEMENT_RESULT=""
LOOP_RESULT=""
GUARDRAILS_RESULT=""
ANY_FAILED=0

echo "=========================================="
echo "  Agent Credit — Proof Stack"
echo "=========================================="
echo ""

# --- Prerequisites ---
echo "Prerequisites:"

if ! curl -s --max-time 5 "$SIDECAR/health" | grep -q '"ok"' 2>/dev/null; then
  echo "  ✗ Sidecar not responding at $SIDECAR"
  echo "  Start it first. Aborting."
  exit 1
fi
echo "  ✓ Sidecar healthy"

if ! curl -s --max-time 5 "$AGENT/api/reserves" | grep -q '"id"' 2>/dev/null; then
  echo "  ✗ Agent Tab not responding at $AGENT"
  echo "  Start it first. Aborting."
  exit 1
fi
echo "  ✓ Agent Tab responding"

# Detect authority-demo fixture
AUTHORITY_PRESENT=false
if curl -s --max-time 5 "$AGENT/api/pool/summary" | grep -q "auth-demo" 2>/dev/null; then
  AUTHORITY_PRESENT=true
  echo "  ✓ Authority demo fixture detected"
else
  echo "  ○ Authority demo fixture not present (authority tests will be skipped)"
fi

echo ""

# --- Suite 1: Settlement substrate ---
echo "------------------------------------------"
echo "  Suite 1: Settlement Substrate"
echo "------------------------------------------"
bash scripts/validate.sh
if [ $? -eq 0 ]; then
  SETTLEMENT_RESULT="12/12"
else
  SETTLEMENT_RESULT="FAILED"
  ANY_FAILED=1
fi
echo ""

# --- Suite 2 & 3: Authority (if fixture present) ---
if [ "$AUTHORITY_PRESENT" = true ]; then

  echo "------------------------------------------"
  echo "  Suite 2: Authority Loop (positive)"
  echo "------------------------------------------"
  npx tsx scripts/test-authority-loop.ts
  if [ $? -eq 0 ]; then
    LOOP_RESULT="9/9"
  else
    LOOP_RESULT="FAILED"
    ANY_FAILED=1
  fi
  echo ""

  echo "------------------------------------------"
  echo "  Suite 3: Authority Guardrails (negative)"
  echo "------------------------------------------"
  npx tsx scripts/test-authority-guardrails.ts
  if [ $? -eq 0 ]; then
    GUARDRAILS_RESULT="18/18"
  else
    GUARDRAILS_RESULT="FAILED"
    ANY_FAILED=1
  fi
  echo ""

else
  LOOP_RESULT="skipped"
  GUARDRAILS_RESULT="skipped"
fi

# --- Summary ---
echo "=========================================="
echo "  Proof Stack Summary"
echo "=========================================="
echo ""
echo "  Settlement substrate:    $SETTLEMENT_RESULT"
echo "  Authority loop:          $LOOP_RESULT"
echo "  Authority guardrails:    $GUARDRAILS_RESULT"
echo ""

if [ "$AUTHORITY_PRESENT" = false ]; then
  echo "  Authority tests skipped. To include them:"
  echo "    npx tsx scripts/seed-authority-demo.ts"
  echo ""
fi

if [ $ANY_FAILED -eq 0 ]; then
  if [ "$AUTHORITY_PRESENT" = true ]; then
    echo "  Total: 39/39 ✓"
  else
    echo "  Total: 12/12 ✓ (authority not tested)"
  fi
else
  echo "  SOME SUITES FAILED"
fi

echo "=========================================="

exit $ANY_FAILED
