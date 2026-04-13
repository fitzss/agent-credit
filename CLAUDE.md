# Agent Credit

Governed credit for AI agents. Bounded delegated authority, off-chain obligations, on-chain reserve-backed settlement on Ergo.

## Current state

**49/49 proof stack.** All amounts are BigInt nanoCredits. Agent-bound delegations enforced. Trust-signal adapter seam operational. Run `cd agent-tab && bash scripts/prove.sh` to verify before doing anything.

## Architecture

- `agent-tab/` — Next.js app, port 3000. Product layer: obligations, delegations, pool UI, proof scripts.
- `chaincash/` — JVM sidecar, port 8081. Schnorr sigs, AVL proofs, Ergo tx building. **Off-limits to app-layer work.**
- Ergo node at port 9052. Private testnet. Wallet password `hello`, API key `hello`.

## Start services

```bash
cd ~/ergo && java -jar ergo-5.0.14.jar --testnet -c ergo.conf
curl -X POST http://localhost:9052/wallet/unlock -H "api_key: hello" -H "Content-Type: application/json" -d '{"pass":"hello"}'
cd chaincash && sbt "runMain chaincash.sidecar.SidecarServer"
cd agent-tab && DEMO_MODE=true npx next dev -p 3000
```

## Do not change without explicit approval

- `chaincash/` — sidecar, Basis contract, settlement mechanics
- `NANOCREDITS_PER_CREDIT` or the nanoCredits storage convention (`src/lib/credits.ts`)
- The proof stack baseline (49 checks) — new work adds checks, nothing lowers the bar
- Reserve/PendingRedemption/TrackerEntry BigInt fields — these predate the migration

## Money convention

All monetary values are `BigInt` nanoCredits. `1.00 credits` = `BigInt(1_000_000_000)`. v1 settlement: 1 nanoCredit = 1 nanoERG (identity). `parseCredits("0.10")` → `BigInt(100_000_000)`. No `parseFloat` anywhere in the money path. See `src/lib/credits.ts`.

## Key files

| File | Role |
|---|---|
| `src/lib/credits.ts` | Canonical constant, formatCredits, parseCredits, nanoCreditsToNanoErg |
| `src/lib/reconcile.ts` | Settlement reconciliation — most complex business logic |
| `src/lib/tracker/service.ts` | Obligation propose/commit, delegation enforcement |
| `src/lib/tracker/delegation.ts` | Delegation scope check, message builders v1/v2 |
| `src/lib/adapters/trust-signal.ts` | Partner trust-signal gate (v0, static dispatch) |
| `src/app/api/proxy/route.ts` | Agent metering proxy — tool calls create obligations |
| `src/app/pool/[id]/page.tsx` | Primary operator dashboard |
| `prisma/schema.prisma` | 16 models, all money fields BigInt |
| `scripts/prove.sh` | Unified proof runner |

## Fixtures

**Canonical** (always present): Demo Debtor, DataMesh AI, CodeForge AI, reserve `e7f6f1c2` with real on-chain ERG.

**Authority demo** (on-demand): `npx tsx scripts/seed-authority-demo.ts` creates Bolt Labs (self-custody) with agent-bound delegations. Cleanup: `--cleanup`. Root key in `.demo-state/`.

## For deeper context

- `README.md` — project overview, proof stack, repo map
- `docs/milestone-summary.md` — what is proven, what is not, reviewer quickstart, FAQ
- `docs/partners/v1-integration-rulebook.md` — integration discipline (core vs adapter vs fixture)
- `docs/glossary.md` — domain terms defined
- `Agent_Credit_Whitepaper.md` — obligation-first thesis
