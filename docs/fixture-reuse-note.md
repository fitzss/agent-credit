# Fixture Reuse Note

How to reuse the canonical demo fixture across days and weeks.

## What persists across reboots

Everything. The chain data (`~/ergo/.ergo/`), the DB (`agent-tab/prisma/dev.db`), and the secret files (`~/.chaincash-secrets/`) are all on-disk. A reboot only stops the three processes.

## What can drift

| Thing | How it drifts | Risk |
|---|---|---|
| Reserve value | Each demo redemption reduces it | Medium — eventually runs out of ERG |
| Obligation amounts | Each demo changes them | Low — easy to reset with the warmup script |
| AVL tree digest | Resets after redemption | None — auto-synced by the refresh endpoint |
| Block height | Keeps climbing while node runs | None — no effect on demo |
| Tracker boxes | New ones deployed each redemption | None — old ones become stale, new ones auto-deploy |

## When to restore the DB snapshot

Restore `~/ergo-testnet-backup/demo-baseline.db` when:

- You ran several demos and the obligation/settlement history is cluttered
- You accidentally deleted or corrupted a record
- You want to start a demo from a clean slate without old settlement events showing up

After restoring, restart Agent Tab. The chain state won't match the restored DB exactly (chain has moved forward), so run `curl -X PATCH http://localhost:3000/api/reserves -H 'Content-Type: application/json' -d '{"reserveId":"e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c"}'` to re-sync the reserve value from chain.

## When you need a full chain rebuild (~2 hours)

Only if `~/ergo/.ergo/` is deleted or corrupted. This has never happened accidentally. As long as you don't `rm -rf ~/ergo/.ergo/`, you never need to rebuild.

## Smallest sanity checks before trusting the environment

```bash
# 1. Node alive and synced?
curl -s http://localhost:9052/info | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Height: {d[\"fullHeight\"]}')"

# 2. Wallet unlocked?
curl -s http://localhost:9052/wallet/status -H "api_key: hello" | python3 -c "import sys,json; print(f'Unlocked: {json.load(sys.stdin)[\"isUnlocked\"]}')"

# 3. Reserve visible?
curl -s "http://localhost:8081/reserve/status?reserveTokenId=2b700ca1aa418fdf1cbbbd98c2122ff9bf1afd7b5b2809637b5350c35c40d937" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Found: {d[\"found\"]}, value: {d[\"valueNanoErg\"]/1e9} ERG')"

# 4. Full harness
cd ~/agent-credit/agent-tab && bash scripts/validate.sh
```

If checks 1-3 pass, you can demo. Check 4 takes ~2 minutes and is the full confidence gate.

## Reserve depletion math

The reserve started at 1.0 ERG and is now at 0.77 ERG. Each demo redemption uses 0.05-0.15 ERG depending on obligation amounts. At the current rate, you have roughly 5-15 more demos before the reserve runs low. When it drops below 0.10 ERG, top it up by deploying a new reserve with fresh collateral.
