# Demo Operator Checklist

Pre-flight and execution checklist for a smooth live demo.

## 30 minutes before

- [ ] Verify Ergo testnet node is running and mining: `curl -s http://localhost:9052/info | jq .fullHeight`
- [ ] Verify wallet is unlocked: `curl -s http://localhost:9052/wallet/status -H "api_key: hello" | jq .isUnlocked`
- [ ] Kill any stale Agent Tab: `pkill -f "next dev"`
- [ ] Clear dev cache: `cd agent-tab && rm -rf .next`
- [ ] Start sidecar (if not running): `cd chaincash && sbt "runMain chaincash.sidecar.SidecarServer"`
- [ ] **From the agent-tab directory**: `cd agent-tab && DEMO_MODE=true npx next dev -p 3000`
- [ ] Warm up (wait 15s then): `curl -s http://localhost:3000/api/reserves | jq length`
- [ ] Run regression harness: `cd agent-tab && bash scripts/validate.sh` → confirm 12/12
- [ ] **Clean up after harness**: `curl -s -X POST http://localhost:3000/api/reserves/recover-pending -H 'Content-Type: application/json' -d '{"reserveId":"<v2-reserve-id>"}'`
- [ ] Set up demo debt: ensure obligations have `currentAmount > 0` for both pairs

## 5 minutes before

**Order matters: do novation setup BEFORE tracker pre-deploy.**

- [ ] If you plan to demo novation, set up the source obligation debt now
- [ ] **Do the novation now** (if demoing it) — this changes debt amounts
- [ ] **Then** pre-deploy tracker for the pair you plan to redeem live:
  ```bash
  curl -X POST http://localhost:3000/api/tracker/deploy \
    -H 'Content-Type: application/json' \
    -d '{"reserveId":"<v2-reserve-id>","obligationId":"<obligation-id>"}'
  ```
- [ ] Wait for tracker confirmation (~1-2 minutes)
- [ ] Verify: `curl -s http://localhost:8081/health | jq .status`

## Demo execution order

### Part 1: Instant features (~3 minutes, no chain waiting)

1. **Show system state** — reserves, obligations, tracker entries
2. **Novation** — transfer debt from B to C (instant, already done in prep OR do live)
3. **Guardrails** — show duplicate block, v1 repeat block
4. **Regression harness** — if not already run, `bash scripts/validate.sh` (12/12)

### Part 2: Chain proof (~2-5 minutes)

5. **Redeem** — `POST /api/reserves/redeem` (tracker already pre-deployed and aligned)
6. **If pending** — recover (see below)
7. **Verify consistency** — compare app state vs sidecar chain state

### If redemption returns `phase: "pending"`

**This is the self-healing mechanism working, not a failure.** Say:

> "The transaction is submitted and in the Ergo mempool. The system detected this is taking longer than the poll window, so it saved a recovery record. This is by design — no data is lost. On a production network with consistent block times, this would complete inline. Let me show you the recovery..."

```bash
# Wait ~1 minute, then:
curl -X POST http://localhost:3000/api/reserves/recover-pending \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"<id>"}'
```

Expected: `status: "reconciled"`. If `status: "still-pending"`, wait another minute and retry.

> "The system auto-reconciled — the reserve, obligation, and settlement are all updated and consistent with the blockchain. This same recovery runs automatically at the start of every redemption call, so in normal operation the operator doesn't need to do anything manually."

## After demo

- [ ] Verify final app/chain consistency:
  ```bash
  curl -s http://localhost:3000/api/reserves | jq '.[0].valueNanoErg'
  curl -s http://localhost:8081/reserve/status?reserveTokenId=<token> | jq .valueNanoErg
  ```
- [ ] Both values should match
