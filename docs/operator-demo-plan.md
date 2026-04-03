# Operator Demo Plan — Canonical Fixture

Use this plan for every external demo. Do not improvise the fixture.

**Navigation note:** `/pool` auto-redirects to the pool detail view when one
reserve is active. The detail page lives at `/pool/[reserveId]`. If the
authority-demo fixture is also active, `/pool` shows a selector first.

## Canonical fixture IDs (do not change)

| Item | ID |
|---|---|
| Reserve | `e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c` |
| Reserve token | `2b700ca1aa418fdf1cbbbd98c2122ff9bf1afd7b5b2809637b5350c35c40d937` |
| Tracker NFT | `d234898d01d478db47ab2073e4e5289a414be79e0ecb8670a9f4fc44d8d70f5b` |
| Customer | `86c0dc8d-506b-41d8-af24-27abe58499f7` (Demo Debtor) |
| Obligation 1 | `99cb8346-291b-43e6-8767-fb7ac3ca5781` (DataMesh AI) |
| Obligation 2 | `66dade45-e2ab-4b69-a0ea-cd59b8f6a7f9` (CodeForge AI) |

## Demo day sequence

### T-30 min: Start services

```bash
# 1. Node
cd ~/ergo && java -jar ergo-5.0.14.jar --testnet -c ergo.conf &

# 2. Wait for node, unlock wallet
sleep 15
curl -X POST http://localhost:9052/wallet/unlock \
  -H "api_key: hello" -H "Content-Type: application/json" \
  -d '{"pass":"hello"}'

# 3. Sidecar (new terminal)
cd ~/agent-credit/chaincash && sbt "runMain chaincash.sidecar.SidecarServer" &

# 4. Agent Tab (new terminal)
cd ~/agent-credit/agent-tab && rm -rf .next && DEMO_MODE=true npx next dev -p 3000 &
```

Wait ~60 seconds for sidecar compilation and Agent Tab build.

### T-15 min: Validate

```bash
cd ~/agent-credit/agent-tab && bash scripts/validate.sh
```

Expected: **12/12 passed, 0 failed, 0 skipped**

If any fail, stop. Do not demo with failures. See troubleshooting below.

### T-10 min: Verify chain consistency

```bash
# Check reserve is visible on chain
curl -s "http://localhost:8081/reserve/status?reserveTokenId=2b700ca1aa418fdf1cbbbd98c2122ff9bf1afd7b5b2809637b5350c35c40d937" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'Chain: {d[\"found\"]}, value={d[\"valueNanoErg\"]/1e9} ERG')
"
```

### T-5 min: Pre-demo warmup

Set obligation debt levels for the demo beats:

```bash
cd ~/agent-credit/agent-tab && npx tsx -e "
import{PrismaClient}from'@prisma/client';const p=new PrismaClient();
async function main(){
  await p.obligationState.update({where:{id:'99cb8346-291b-43e6-8767-fb7ac3ca5781'},data:{currentAmount:0.10,settlementStatus:'current'}});
  await p.obligationState.update({where:{id:'66dade45-e2ab-4b69-a0ea-cd59b8f6a7f9'},data:{currentAmount:0.05,settlementStatus:'current'}});
  console.log('DataMesh AI: 0.10 credits');
  console.log('CodeForge AI: 0.05 credits');
}
main().finally(()=>p.\$disconnect());
"
```

Pre-deploy the tracker so the redemption doesn't stall waiting for a block:

```bash
curl -s -X POST http://localhost:3000/api/tracker/deploy \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c","obligationId":"99cb8346-291b-43e6-8767-fb7ac3ca5781"}'
```

Wait for one block (~30-60 sec) to confirm the tracker.

### T-0: Demo beats (audience present)

**Beat 1 — State.** Show reserve value on chain. Show obligations.

**Beat 2 — Novation.** Transfer 0.03 credits from DataMesh to CodeForge:
```bash
curl -s -X POST http://localhost:3000/api/debt/transfer \
  -H 'Content-Type: application/json' \
  -d '{"fromObligationId":"99cb8346-291b-43e6-8767-fb7ac3ca5781","toObligationId":"66dade45-e2ab-4b69-a0ea-cd59b8f6a7f9","amountCredits":0.03}'
```
Point out: instant, no chain tx needed.

**Beat 3 — Guardrails.** Show a duplicate or negative transfer getting rejected.

**Beat 4 — Redemption.** Redeem DataMesh obligation:
```bash
curl -s -X POST http://localhost:3000/api/reserves/redeem \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c","obligationId":"99cb8346-291b-43e6-8767-fb7ac3ca5781"}'
```
Tx goes to pending. Recover after one block:
```bash
curl -s -X POST http://localhost:3000/api/reserves/recover-pending \
  -H 'Content-Type: application/json' \
  -d '{"reserveId":"e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c"}'
```

**Beat 5 — Consistency.** Show app and chain match on reserve value.

**Beat 6 — Harness.** Run `bash scripts/validate.sh` to show 12/12.

### Demo docs to follow (in order)

1. `docs/demo-narration.md` — talk track for each beat
2. `docs/demo-checklist.md` — pre-demo and during-demo steps
3. `docs/reviewer-brief.md` — hand to reviewers before or after

## Troubleshooting

| Symptom | Fix |
|---|---|
| Wallet unlock fails | Node not fully started. Wait 15 more seconds, retry. |
| Sidecar returns 404/connection refused | Still compiling. Wait 60 seconds. |
| Reserve not found on chain | Sidecar not connected to node. Check `curl localhost:8081/health`. |
| Harness < 12/12 | Do not demo. Check which test failed. If drift test: run `curl -X PATCH http://localhost:3000/api/reserves -H 'Content-Type: application/json' -d '{"reserveId":"e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c"}'` to refresh digest. |
| Redemption stuck pending | Wait for next block (up to 60 sec), then recover-pending. |
| DB corrupted | `cp ~/ergo-testnet-backup/demo-baseline.db ~/agent-credit/agent-tab/prisma/dev.db` and restart Agent Tab. |

## Proof Stack

Run the full proof suite before any external demo:

```bash
cd agent-tab && bash scripts/prove.sh
```

| Suite | Layer | Checks | What it proves |
|---|---|---|---|
| `validate.sh` | Settlement substrate | 12 | Redemption, recovery, drift detection, transfer guardrails, duplicate blocking, contract versioning |
| `test-authority-loop.ts` | Positive authority | 6 | Create delegation → proxy call with session key → session signing → spend cap decrements → pool dashboard reflects |
| `test-authority-guardrails.ts` | Negative authority | 10 | Wrong scope, expired, exceeded cap, and revoked delegations all rejected without mutating commercial state |

**28/28 = system verified.** If any suite fails, do not demo.

Authority tests require the authority-demo fixture:
```bash
npx tsx scripts/seed-authority-demo.ts        # seed
npx tsx scripts/seed-authority-demo.ts --cleanup  # remove
```
Without the fixture, `prove.sh` runs settlement tests only (12/12) and skips authority tests with a note.
