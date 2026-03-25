# Validation Matrix

Regression scenarios for the Agent Tab + ChainCash settlement system.

## Scenarios

| # | Scenario | Type | Requires chain | Expected |
|---|---|---|---|---|
| 1 | One-shot redemption (first pair, first redeem) | Happy path | Yes | Reserve decreases, obligation settled, settlement event created |
| 2 | Repeated same-pair redemption (second redeem, same pair) | Happy path | Yes | .update() path, cumulative redeemed increases |
| 3 | Multi-pair tracker preservation | Happy path | Yes | Redeem pair B, verify pair A's entry still in tracker |
| 4 | Novation then redeem both pairs | Happy path | Yes | Transfer changes amounts, both pairs redeemable |
| 5 | Pending redemption recovery | Recovery | Yes | Pending record created, auto-recovered on retry |
| 6 | Duplicate reconciliation prevention | Guardrail | No (DB only) | 409 with existing settlement ID |
| 7 | V1 reserve repeat block | Guardrail | No | 409: "v1 cannot redeem again" |
| 8 | Stale tracker auto-redeploy | Auto-heal | Yes | Tracker auto-deployed, redemption proceeds |
| 9 | R5 digest drift detection | Guardrail | No (DB tamper) | 409: "drift detected" |
| 10 | Missing tracker deployment | Guardrail→Auto | Yes | Auto-deploys tracker, proceeds |
| 11 | Secret file auto-provisioning | Auto-heal | No | Files created from DB keys |
| 12 | Transfer guardrails (same debtor, sufficient amount, no pending) | Guardrail | No | Various 400/409 rejections |
| 13 | Contract version derivation | Metadata | Sidecar only | v1/v2 correctly identified on refresh |
