# Demo Operator Checklist

Pre-flight and execution checklist for a smooth live demo.

## 30 minutes before

- [ ] Verify Ergo testnet node is running and mining: `curl -s http://localhost:9052/info | jq .fullHeight`
- [ ] Verify wallet is unlocked: `curl -s http://localhost:9052/wallet/status -H "api_key: hello" | jq .isUnlocked`
- [ ] Kill any stale Agent Tab: `pkill -f "next dev"`
- [ ] Clear dev cache: `cd agent-tab && rm -rf .next`
- [ ] Start sidecar (if not running): `cd chaincash && sbt "runMain chaincash.sidecar.SidecarServer"`
- [ ] Start Agent Tab in demo mode: `cd agent-tab && DEMO_MODE=true npx next dev -p 3000`
- [ ] Warm up: `curl -s http://localhost:3000/api/reserves | jq length`
- [ ] Run regression harness: `bash scripts/validate.sh` → confirm 12/12

## 5 minutes before

- [ ] Ensure at least one obligation has `currentAmount > 0` against the V2 reserve
- [ ] Pre-deploy tracker for the pair you plan to redeem live:
  ```bash
  curl -X POST http://localhost:3000/api/tracker/deploy \
    -H 'Content-Type: application/json' \
    -d '{"reserveId":"<v2-reserve-id>","obligationId":"<obligation-id>"}'
  ```
- [ ] Wait for tracker confirmation (~1-2 minutes)
- [ ] Verify tracker is live: check sidecar health responds `"ok"`

## Demo execution order

### Part 1: Instant features (~3 minutes)

1. **Show system state** — reserves, obligations, tracker entries
2. **Novation** — transfer debt from B to C (instant, no chain wait)
3. **Guardrails** — show duplicate block, v1 repeat block
4. **Regression harness** — `bash scripts/validate.sh` (12/12 in ~2 min)

### Part 2: Chain proof (~2-5 minutes)

5. **Redeem** — `POST /api/reserves/redeem` (tracker already pre-deployed)
6. **Verify consistency** — compare app state vs sidecar chain state

### If redemption returns `phase: "pending"`

This is normal on a private testnet with variable block times. Explain:

> "The transaction has been submitted and accepted by the Ergo mempool. The system saved a recovery record. On a production network with consistent 2-minute blocks, this would confirm within the poll window. Let me trigger the recovery..."

Then:
```bash
curl -X POST http://localhost:3000/api/reserves/recover-pending \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"<id>"}'
```

This should return `status: "reconciled"`. If it returns `status: "still-pending"`, wait another minute and retry.

## After demo

- [ ] Verify final app/chain consistency:
  ```bash
  curl -s http://localhost:3000/api/reserves | jq '.[0].valueNanoErg'
  curl -s http://localhost:8081/reserve/status?reserveTokenId=<token> | jq .valueNanoErg
  ```
- [ ] Both values should match
