# Demo Day Cheat Sheet

One-page operator reference. Print this.

---

## 30 min before

```bash
cd agent-tab && rm -rf .next
cd agent-tab && DEMO_MODE=true npx next dev -p 3000    # MUST be in agent-tab dir
# Wait 15s...
curl -s http://localhost:3000/api/reserves | jq length  # Should show ≥1
bash scripts/validate.sh                                 # Should show 12/12
# Clean up after harness:
curl -s -X POST http://localhost:3000/api/reserves/recover-pending \
  -H 'Content-Type: application/json' -d '{"reserveId":"<V2_RESERVE_ID>"}'
```

## 5 min before

**Novation FIRST, then tracker pre-deploy.**

```bash
# 1. Set up debt for demo pairs (if needed)
# 2. Do novation NOW (if demoing it):
curl -X POST http://localhost:3000/api/debt/transfer -H 'Content-Type: application/json' \
  -d '{"fromObligationId":"<FROM>","toObligationId":"<TO>","amountCredits":0.03}'

# 3. THEN pre-deploy tracker:
curl -X POST http://localhost:3000/api/tracker/deploy -H 'Content-Type: application/json' \
  -d '{"reserveId":"<V2_RESERVE_ID>","obligationId":"<REDEEM_OBLIGATION_ID>"}'
# Wait ~2 min for confirmation
```

## Demo flow

| # | Beat | Time | Command |
|---|---|---|---|
| 1 | System state | 10s | `curl -s http://localhost:3000/api/reserves \| jq ...` |
| 2 | Novation | 5s | Already done in prep, or show transfer endpoint |
| 3 | Guardrails | 10s | Show duplicate block + v1 block |
| 4 | Harness | 2min | `bash scripts/validate.sh` (if not already run) |
| 5 | **Redeem** | 30s-5min | `curl -X POST .../api/reserves/redeem ...` |
| 6 | Consistency | 5s | App value == chain value |

## Fallback commands

```bash
# Redemption pending? Recover:
curl -X POST http://localhost:3000/api/reserves/recover-pending \
  -H 'Content-Type: application/json' -d '{"reserveId":"<ID>"}'

# Still pending? Wait 1 min, retry same command.

# Agent Tab crashed / pages not found?
cd agent-tab && rm -rf .next && DEMO_MODE=true npx next dev -p 3000
# Wait 15s, warm up with: curl http://localhost:3000/api/reserves

# Sidecar down?
cd chaincash && sbt "runMain chaincash.sidecar.SidecarServer"
```

## What to say if redemption is pending

> "The transaction is in the Ergo mempool. The system saved a recovery record — no data is lost. On a production network this would confirm inline. Let me show the self-healing recovery..."

*Run recover-pending. Show reconciled result.*

> "The system auto-reconciled. Reserve, obligation, and settlement are all consistent with the blockchain."

## Don't forget

1. **Start Agent Tab from the `agent-tab/` directory** — wrong dir = crash
2. **Do novation BEFORE tracker pre-deploy** — novation changes debt, invalidates tracker
3. **Run recover-pending after the harness** — harness may leave pending records
4. **Budget 5 minutes for the chain proof beat** — block times vary
5. **Float display (`0.039999...`)** — say "prototype uses floating point; production would use integer nanoERG"
