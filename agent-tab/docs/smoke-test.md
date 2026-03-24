# Smoke Test Checklist

Scriptable verification for the V2 repeatable settlement path.
All commands assume: node on :9052, sidecar on :8081, Agent Tab on :3000.

## 1. Service health

```bash
curl -s http://localhost:8081/health | jq .status
# Expected: "ok"

curl -s http://localhost:3000/api/reserves | jq length
# Expected: ≥1
```

## 2. Reserve version is correct

```bash
# Refresh a v2 reserve and check version
curl -s -X PATCH http://localhost:3000/api/reserves \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<v2-reserve-id>"}' | jq '.reserve.contractVersion'
# Expected: "v2"

# Refresh a v1 reserve and check version
curl -s -X PATCH http://localhost:3000/api/reserves \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<v1-reserve-id>"}' | jq '.reserve.contractVersion'
# Expected: "v1"
```

## 3. One-shot redeem works end to end

Prerequisites: a v2 reserve with an unsettled obligation (`currentAmount > 0`).

```bash
# Capture reserve value before
BEFORE=$(curl -s http://localhost:8081/reserve/status?reserveTokenId=<token> | jq .valueNanoErg)

# Redeem
RESULT=$(curl -s -X POST http://localhost:3000/api/reserves/redeem \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"<id>","obligationId":"<id>"}')

PHASE=$(echo $RESULT | jq -r .phase)
echo "Phase: $PHASE"
# Expected: "complete" or "pending"

# If pending, wait and recover
if [ "$PHASE" = "pending" ]; then
  sleep 90
  curl -s -X POST http://localhost:3000/api/reserves/recover-pending \
    -H 'Content-Type: application/json' \
    -d '{"reserveId":"<id>"}' | jq '.recovered[].status'
  # Expected: "reconciled"
fi

# Check reserve value decreased
AFTER=$(curl -s http://localhost:8081/reserve/status?reserveTokenId=<token> | jq .valueNanoErg)
echo "Before: $BEFORE After: $AFTER"
# Expected: AFTER < BEFORE
```

## 4. Pending recovery works

This is tested implicitly by step 3 if the phase was "pending". To test explicitly:

```bash
# Check for any pending redemptions
curl -s -X POST http://localhost:3000/api/reserves/recover-pending \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"<id>"}' | jq .
# Expected: {"message":"No pending redemptions","recovered":[]} or recovered entries
```

## 5. Repeated same-pair redemption works (v2 only)

After step 3 settles the obligation:

```bash
# Increase debt again (simulate new spending)
# Update obligation.currentAmount > 0 and settlementStatus = "current" in DB

# Redeem again — same reserve, same obligation
curl -s -X POST http://localhost:3000/api/reserves/redeem \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"<id>","obligationId":"<id>"}' | jq .phase
# Expected: "complete" or "pending" (NOT an error about insert-only or tracker stale)
# If "pending", recover as in step 3

# Verify reserve value decreased again
curl -s http://localhost:8081/reserve/status?reserveTokenId=<token> | jq .valueNanoErg
# Expected: less than after step 3
```

## 6. App and chain state match

```bash
# Get app state
APP_VALUE=$(curl -s http://localhost:3000/api/reserves?customerId=<id> \
  | jq -r '.[0].valueNanoErg')

# Get chain state
CHAIN_VALUE=$(curl -s http://localhost:8081/reserve/status?reserveTokenId=<token> \
  | jq .valueNanoErg)

echo "App: $APP_VALUE Chain: $CHAIN_VALUE"
# Expected: equal
```

## 7. Guardrail checks

### v1 reserve blocks repeat
```bash
# Try redeeming a v1 reserve for a pair that already has a settlement
curl -s -X POST http://localhost:3000/api/reserves/redeem \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"<v1-id>","obligationId":"<same-pair-id>"}' | jq .error
# Expected: "Reserve is v1 (insert-only)..."
```

### Duplicate reconciliation blocked
```bash
# Try reconciling the same txId twice
curl -s -X POST http://localhost:3000/api/reserves/reconcile-redemption \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"<id>","obligationId":"<id>","redemptionTxId":"<already-reconciled-tx>","grossRedeemNanoErg":100000000}' \
  | jq .error
# Expected: "Redemption already reconciled"
```

## Pass criteria

All 7 checks pass. No manual secret file creation needed. No manual tracker deploy needed. App and chain values match after reconciliation.
