# Demo Walkthrough

Step-by-step demonstration of the Agent Credit settlement system.
Assumes: Ergo node on :9052, sidecar on :8081, Agent Tab on :3000.

## Prerequisites

Start Agent Tab in **demo mode** for longer confirmation windows:
```bash
cd agent-tab && DEMO_MODE=true npx next dev -p 3000
```

Demo mode increases polling: 3 minutes for redemption confirmation (vs 30s normal), 6 minutes for tracker deployment (vs 2min normal). This avoids `phase: "pending"` interruptions during a live demo.

Verify services are running:
```bash
curl -s http://localhost:8081/health | jq .status    # "ok"
curl -s http://localhost:3000/api/reserves | jq length  # ≥1
```

## 1. Show current system state

```bash
# Reserves
curl -s http://localhost:3000/api/reserves | jq '.[] | {id: .id[0:8], value: .valueNanoErg, version: .contractVersion, lifecycle}'

# Obligations with debt
curl -s http://localhost:3000/api/obligations | jq '.[] | select(.currentAmount > 0) | {id: .id[0:8], amount: .currentAmount, status: .settlementStatus}'
```

## 2. Create debt

Give a pair some credit to work with:
```bash
# Via the obligations API (or directly update an existing obligation)
curl -X POST http://localhost:3000/api/obligations \
  -H 'Content-Type: application/json' \
  -d '{"providerId": "<provider-id>", "customerId": "<customer-id>", "amount": 0.05}'
```

## 3. Redeem (one call does everything)

**Demo tip:** For a smoother live demo, pre-deploy the tracker ~2 minutes before redeeming. This separates the slow tracker confirmation from the redemption call:
```bash
# Pre-deploy tracker (do this first, then wait for confirmation)
curl -X POST http://localhost:3000/api/tracker/deploy \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<v2-reserve-id>", "obligationId": "<obligation-id>"}'
# Wait ~2 minutes for block confirmation, then redeem:
```

```bash
curl -X POST http://localhost:3000/api/reserves/redeem \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<v2-reserve-id>", "obligationId": "<obligation-id>"}'
```

What happens automatically:
1. Secret files provisioned from DB
2. Tracker staleness detected → auto-deployed with correct cumulative debt
3. R5 digest validated against chain
4. Sidecar builds Schnorr signatures + AVL proofs
5. Redemption tx submitted
6. If confirmed within 30s → reconciled (reserve, obligation, settlement updated)
7. If timeout → `PendingRedemption` saved → auto-recovers on next call

**If you get `phase: "pending"`:**
```bash
# Wait ~1-2 minutes, then either:
curl -X POST http://localhost:3000/api/reserves/recover-pending \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<id>"}'

# Or just call /redeem again — it auto-recovers first
```

## 4. Verify on-chain consistency

```bash
# App state
curl -s http://localhost:3000/api/reserves | jq '.[0] | {value: .valueNanoErg, box: .boxId[0:16]}'

# Chain state
curl -s http://localhost:8081/reserve/status?reserveTokenId=<token> | jq '{value: .valueNanoErg, box: .boxId[0:16]}'

# Should match
```

## 5. Demonstrate repeated same-pair redemption

After step 3 settles the obligation, increase the debt again:
```bash
# Update obligation (simulate new usage)
# Then redeem again — same reserve, same obligation
curl -X POST http://localhost:3000/api/reserves/redeem \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<id>", "obligationId": "<id>"}'
```

The system auto-detects the tracker is stale (cumulative debt increased), deploys a new tracker with the updated value, and redeems using the `.update()` path.

## 6. Demonstrate multi-pair support

With two obligations against the same reserve (different creditors):
```bash
# Redeem pair (A,B)
curl -X POST http://localhost:3000/api/reserves/redeem \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<id>", "obligationId": "<A-B-obligation>"}'

# Redeem pair (A,C) — tracker auto-updates with both entries
curl -X POST http://localhost:3000/api/reserves/redeem \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<id>", "obligationId": "<A-C-obligation>"}'
```

Both pairs preserved in the same tracker tree. Neither redemption erases the other pair's entry.

## 7. Demonstrate novation (debt transfer)

Transfer debt from one creditor to another:
```bash
curl -X POST http://localhost:3000/api/debt/transfer \
  -H 'Content-Type: application/json' \
  -d '{
    "fromObligationId": "<A-B-obligation>",
    "toObligationId": "<A-C-obligation>",
    "amountCredits": 0.03
  }'
```

Response shows updated amounts for both obligations. The tracker auto-updates on the next redemption for either pair.

Then redeem the transferred debt:
```bash
curl -X POST http://localhost:3000/api/reserves/redeem \
  -H 'Content-Type: application/json' \
  -d '{"reserveId": "<id>", "obligationId": "<A-C-obligation>"}'
```

## 8. Show guardrails

```bash
# Duplicate reconciliation
curl -X POST http://localhost:3000/api/reserves/reconcile-redemption \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"...","obligationId":"...","redemptionTxId":"<already-used>","grossRedeemNanoErg":100000000}'
# → 409: "Redemption already reconciled"

# V1 reserve repeat block
# (attempt second redemption against v1 reserve for same pair)
# → 409: "Reserve is v1 (insert-only)"

# Transfer guardrails
# (different debtor, self-transfer, negative amount, insufficient)
# → various 400/409 rejections
```

## 9. Run the regression harness

```bash
cd agent-tab && bash scripts/validate.sh
# Expected: 12 passed, 0 failed, 0 skipped
```

## Key numbers from testnet sessions (approximate — state evolves with testing)

| Metric | Value |
|---|---|
| V2 reserve initial collateral | 1.00 ERG |
| Total redeemed (11+ settlements) | 0.72+ ERG |
| Remaining reserve | ~0.28 ERG |
| Debt transfers executed | 3+ |
| Distinct creditor pairs | 2 |
| Tracker deployments (history) | 8+ |
| Settlement events | 9 |
| All app/chain matches confirmed | Yes |
