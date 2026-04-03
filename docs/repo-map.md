# Repository Map

## If you only read three things

1. [`docs/milestone-summary.md`](milestone-summary.md) — what is proven, what is not
2. `cd agent-tab && bash scripts/prove.sh` — run the proof stack
3. `http://localhost:3000/pool` — open the operator dashboard

## Top-level structure

```
agent-tab/      Product layer (Next.js)
chaincash/      Chain execution layer (JVM/Scala)
docs/           Reviewer and operator documentation
README.md       Entry point
```

## agent-tab/

The operator-facing product. This is where most of the application logic lives.

| Path | What it is |
|---|---|
| `src/app/pool/` | Pool selector + single-pool detail page (`/pool/[id]`) |
| `src/app/api/reserves/` | Reserve management, redemption, reconciliation |
| `src/app/api/delegations/` | Delegation create/revoke |
| `src/app/api/proxy/` | Agent metering proxy (auth, credit check, delegation scope) |
| `src/app/api/debt/transfer/` | Novation endpoint |
| `src/app/api/pool/summary/` | Pool summary API (health, obligations, authority, tracker, settlements) |
| `src/lib/reconcile.ts` | Core reconciliation logic, tracker alignment, cumulative debt |
| `src/lib/tracker/` | Tracker service, delegation scope checking, signing |
| `src/lib/crypto.ts` | secp256k1 keypair generation, ECDSA signing/verification |
| `scripts/prove.sh` | Unified proof runner (28 checks) |
| `scripts/validate.sh` | Settlement substrate harness (12 checks) |
| `scripts/test-authority-loop.ts` | Positive authority proof (6 checks) |
| `scripts/test-authority-guardrails.ts` | Negative authority proof (10 checks) |
| `scripts/seed-authority-demo.ts` | Self-contained authority demo fixture |
| `prisma/schema.prisma` | Data model (SQLite) |

## chaincash/

The chain execution sidecar. Handles everything that touches Ergo directly.

| Path | What it is |
|---|---|
| `src/.../sidecar/SidecarServer.scala` | HTTP sidecar: reserve deploy, redeem, tracker deploy/update |
| `contracts/offchain/basis.es` | Basis reserve contract (ErgoScript) |
| `src/test/.../BasisSpec.scala` | Contract-level tests (27 tests) |

## docs/

| Document | Audience | Purpose |
|---|---|---|
| `milestone-summary.md` | Reviewer | What is proven, what is not, quickstart, FAQ |
| `operator-demo-plan.md` | Operator | Demo sequence, proof stack, troubleshooting |
| `fixture-reuse-note.md` | Operator | Persistence, drift, restore procedures |
| `glossary.md` | Both | Key terms defined |
| `repo-map.md` | Both | This file |
