# Redemption Runtime Checkpoint

## Git
- commit: 0503e5b

## Redeemable Test Pair
- customerName: Redeemable Test Co
- customerId: c29eadb1-3d0b-4d14-9e5a-482ce24fa918
- customerPubKey: 0268b7c456354571b8a7c5005469c9776153b3b5cf1e23c74d5b6826b23e14ba60
- reserveId: bf486d82-77ae-40ab-85b8-f201989c9fee
- reserveTokenId: adb60a1fd42493a287e068736bb7f5b45f12b9c5966d40bddb6e52dbf57cdd4c
- reserveBoxId: 80fddfb7bc2177ebf9dccc80808487a0a0170279e65420dcf46031d76109354f
- trackerNftId: 613791b6428ead5f6db0c877fd530bfdeffb5791d9fe3842471170392343cda2

## Golden Path Objects
- obligationId: f5ddc90d-bcde-4530-8c04-2cae21c5301e
- providerId: daee22e5-8446-495d-beea-0477e82c0906
- toolId: 9ddbbca5-a832-46be-9bd5-a07bdc711e2e
- agentId: c36fe876-0674-4643-92af-bdeac2748bde
- agentApiKeyLabel: redeem-tester (apiKey: agent-key-redeem-001)

## On-Chain State (verified via sidecar)
- reserveValueNanoErg: 1000000000
- onChainOwnerPubKey: 0268b7c456354571b8a7c5005469c9776153b3b5cf1e23c74d5b6826b23e14ba60
- onChainTrackerNftId: 613791b6428ead5f6db0c877fd530bfdeffb5791d9fe3842471170392343cda2
- avlTreeDigest: 4ec61f485b98eb87153f7c57db4f5ecd75556fddbc403b41acf8441fde8e160900032000
- creationHeight: 1500

## Redeemability
- customerKeyMatchesOnChainR4: true
- debtorPubKeyMatchesCustomer: true
- trackerNftIdMatchesOnChain: true
- redeemable: true

## Notes
- Customer signing mode is self-custody (ECDSA secp256k1, 64-byte compact signatures)
- Basis contract requires Schnorr signatures (secp256k1, 66-byte) — different scheme, same curve
- Denomination: 1 credit = 1 ERG = 1,000,000,000 nanoERG (prototype assumption)
- The obligation has currentAmount=0.1 credits, version=1, signed and verified
- The reserve collateralization ratio is 10x (1 ERG reserve / 0.1 credit debt)
- The AVL tree digest is the empty tree — no notes have been committed on-chain yet
- Ergo private testnet node running on port 9052, sidecar on 8081, Agent Tab on 3000
- Wallet ErgoTree: 0008cd024401ebcb804b96c6fbd79f417d40476c982e5969cce29ac18b1c45f2b038d966
