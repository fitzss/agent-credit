#!/usr/bin/env tsx
/**
 * operator-reserve-init (slice 16a-core)
 *
 * Local operator-owned reserve mode (self-custodial operator reserve
 * foundation). NOT full production self-custody — see
 * docs/operator-reserve-kit.md.
 *
 * Creates a "Self-Custody Operator" Customer + Reserve row + manifest +
 * deploy spec for a reserve the operator owns and signs for, on testnet
 * only, without touching Demo Debtor or the canonical reserve, and
 * without broadcasting, redeeming, or settling.
 *
 * Phases (mutually exclusive):
 *   --prepare --reserve-token-id <hex64> --tracker-nft-id <hex64>
 *           [--initial-collateral-erg <decimal>]   default 0.5
 *           [--generate-keypair]
 *   --sync
 *   --status [--json]
 *
 * Exit codes:
 *   0  success / idempotent no-op
 *   1  recoverable failure (sidecar/node down, chain not yet visible)
 *   2  misuse / canonical-ID collision / mainnet env / corrupt manifest
 *
 * Constraints:
 *   ERGO_NETWORK=testnet required at every entry point.
 *   Canonical reserve identifiers refused.
 *   Demo Debtor untouched.
 *   No --cleanup (deferred to 16b/16c).
 *   No redeem-route call. No broadcast.
 *
 * Files (all gitignored under agent-tab/.demo-state/):
 *   operator-key.json            mode 0o600 — sensitive
 *   operator-reserve.json        mode 0o644 — manifest, no private key
 *   operator-reserve-deploy.json mode 0o600 — unsigned deploy spec
 */

import * as fs from "fs";
import * as path from "path";
import { prisma } from "@/lib/prisma";
import {
  deployReserve,
  getReserveStatus,
  getSidecarHealth,
  deriveContractVersion,
  type DeployResult,
  type ReserveStatus,
  type SidecarHealth,
} from "@/lib/sidecar-client";
import { operatorCookieHeader } from "./lib/test-session";
import {
  generateKeypair,
  readOperatorKey,
  writeOperatorKey,
  signChallenge,
  verifyChallenge,
  keygenSelfTest,
  proofOfControlMessage,
  type OperatorKeyFile,
  type Keypair,
} from "./lib/operator-key";

// ─── Constants ──────────────────────────────────────────────────────────

const SELF_CUSTODY_OPERATOR_NAME = "Self-Custody Operator";

// Canonical denylist. ANY collision in user input → exit 2 BEFORE any side
// effect. Mirrors seed-settlement-demo-reserve.ts.
const CANONICAL_RESERVE_ID = "e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c";
const CANONICAL_RESERVE_TOKEN_ID = "2b700ca1aa418fdf1cbbbd98c2122ff9bf1afd7b5b2809637b5350c35c40d937";
const CANONICAL_TRACKER_NFT_ID = "d234898d01d478db47ab2073e4e5289a414be79e0ecb8670a9f4fc44d8d70f5b";

// Demo Debtor is read-only here; we refuse to touch it.
const DEMO_DEBTOR_CUSTOMER_ID = "86c0dc8d-506b-41d8-af24-27abe58499f7";

const DEMO_STATE_DIR = path.join(__dirname, "..", ".demo-state");
const OPERATOR_KEY_FILE = path.join(DEMO_STATE_DIR, "operator-key.json");
const MANIFEST_FILE = path.join(DEMO_STATE_DIR, "operator-reserve.json");
const DEPLOY_SPEC_FILE = path.join(DEMO_STATE_DIR, "operator-reserve-deploy.json");

const COLLATERAL_FLOOR_NANO_ERG = BigInt(100_000_000);
const COLLATERAL_CEILING_NANO_ERG = BigInt(10_000_000_000);

const AGENT_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

const MANIFEST_VERSION = "16a-core";
const MANIFEST_KIND = "operator-reserve-manifest";
const DEPLOY_KIND = "operator-reserve-deploy-spec";

// ─── Types ──────────────────────────────────────────────────────────────

interface Args {
  phase: "prepare" | "sync" | "status" | "help" | null;
  trackerNftId: string | null;
  reserveTokenId: string | null;
  initialCollateralErg: number;
  generateKeypair: boolean;
  json: boolean;
}

interface ProofOfControl {
  message: string;
  signature: string;
  verifiedAt: string;
  verifiedAgainst: "operator-key.json" | "on-chain-R4";
}

interface Manifest {
  kind: typeof MANIFEST_KIND;
  version: typeof MANIFEST_VERSION;
  reserveId: string;
  reserveTokenId: string;
  trackerNftId: string;
  operatorCustomerId: string;
  operatorPublicKey: string;
  reserveAddress: string;
  network: string;
  lifecycle: string;
  initialCollateralNanoErg: string;
  preparedAt: string;
  syncedAt: string | null;
  proofOfControl: ProofOfControl;
  deploySpecPath: string;
  note: string;
}

interface DeploySpecFile {
  kind: typeof DEPLOY_KIND;
  deploymentRequestJson: unknown;
  reserveAddress: string;
  scanRequestJson?: unknown;
  network: string;
  writtenAt: string;
  writtenBy: string;
  note: string;
}

// ─── CLI parsing ────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const a: Args = {
    phase: null,
    trackerNftId: null,
    reserveTokenId: null,
    initialCollateralErg: 0.5,
    generateKeypair: false,
    json: false,
  };
  let phaseSeen = 0;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--prepare") { a.phase = "prepare"; phaseSeen++; }
    else if (t === "--sync") { a.phase = "sync"; phaseSeen++; }
    else if (t === "--status") { a.phase = "status"; phaseSeen++; }
    else if (t === "--help" || t === "-h") { a.phase = "help"; }
    else if (t === "--json") { a.json = true; }
    else if (t === "--generate-keypair") { a.generateKeypair = true; }
    else if (t === "--tracker-nft-id") {
      const v = argv[++i];
      if (!v) throw new Error("--tracker-nft-id requires a value");
      a.trackerNftId = v.toLowerCase();
    } else if (t === "--reserve-token-id") {
      const v = argv[++i];
      if (!v) throw new Error("--reserve-token-id requires a value");
      a.reserveTokenId = v.toLowerCase();
    } else if (t === "--initial-collateral-erg") {
      const v = argv[++i];
      if (!v) throw new Error("--initial-collateral-erg requires a value");
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--initial-collateral-erg must be positive");
      a.initialCollateralErg = n;
    } else {
      throw new Error(`Unknown flag: ${t}`);
    }
  }
  if (phaseSeen > 1) throw new Error("--prepare, --sync, --status are mutually exclusive");
  return a;
}

function printHelp(): void {
  process.stderr.write(
    `operator-reserve-init (slice 16a-core)\n\n` +
    `Local operator-owned reserve mode. Testnet only. Does NOT broadcast,\n` +
    `redeem, or settle. Demo Debtor and the canonical reserve are not touched.\n\n` +
    `Usage:\n` +
    `  --prepare --reserve-token-id <hex64> --tracker-nft-id <hex64>\n` +
    `           [--initial-collateral-erg <decimal>]    default 0.5\n` +
    `           [--generate-keypair]\n` +
    `  --sync\n` +
    `  --status [--json]\n\n` +
    `Prereqs:\n` +
    `  ERGO_NETWORK=testnet in your environment.\n` +
    `  Either --generate-keypair on first run, or place a valid\n` +
    `  operator-key.json under agent-tab/.demo-state/ (see\n` +
    `  docs/operator-reserve-kit.md for the file shape).\n\n` +
    `Files (all gitignored under agent-tab/.demo-state/):\n` +
    `  operator-key.json            mode 0o600\n` +
    `  operator-reserve.json        mode 0o644\n` +
    `  operator-reserve-deploy.json mode 0o600\n\n` +
    `Exit codes: 0 success, 1 recoverable, 2 misuse / canonical / mainnet.\n`,
  );
}

// ─── Validators ────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
function isHex64(s: string): boolean { return HEX64.test(s); }

function checkCanonicalDenylist(
  reserveId: string | null,
  reserveTokenId: string | null,
  trackerNftId: string | null,
): string | null {
  if (reserveId === CANONICAL_RESERVE_ID) return "reserveId is the canonical reserve";
  if (reserveTokenId === CANONICAL_RESERVE_TOKEN_ID) return "reserveTokenId is the canonical reserve token";
  if (trackerNftId === CANONICAL_TRACKER_NFT_ID) return "trackerNftId is the canonical tracker NFT";
  return null;
}

function assertTestnetEnv(): void {
  const v = process.env.ERGO_NETWORK;
  if (v !== "testnet") {
    const got = v === undefined ? "(unset)" : v === "" ? "(empty)" : v;
    process.stderr.write(
      `Error: ERGO_NETWORK must be "testnet" for slice 16a-core operator-mode scripts. Got: ${got}\n` +
      `       Mainnet is not supported in 16a-core. Set ERGO_NETWORK=testnet in agent-tab/.env.\n`,
    );
    process.exit(2);
  }
}

function assertSidecarTestnet(health: SidecarHealth | null, label: string): void {
  if (!health) {
    process.stderr.write(`Error: sidecar /health unreachable (${label}). Is the chaincash sidecar running?\n`);
    process.exit(1);
  }
  if (health.network !== "testnet") {
    process.stderr.write(
      `Error: sidecar reports network=${JSON.stringify(health.network)} (${label}). 16a-core requires testnet.\n`,
    );
    process.exit(1);
  }
}

function assertDeployResultTestnet(d: DeployResult): void {
  if (d.network !== "testnet") {
    process.stderr.write(
      `Error: sidecar deployReserve response reports network=${JSON.stringify(d.network)}. 16a-core requires testnet.\n`,
    );
    process.exit(1);
  }
}

/**
 * Recursive scan for secret-shaped key names. Mirrors
 * findSecretKeyName from seed-settlement-demo-reserve.ts. VALUES are
 * never inspected, returned, or logged — only KEY names.
 */
function findSecretKeyName(obj: unknown, prefix: string[] = []): string | null {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const found = findSecretKeyName(obj[i], [...prefix, `[${i}]`]);
      if (found) return found;
    }
    return null;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (/secret|private|seed|mnemonic|password/i.test(key)) {
      return [...prefix, key].join(".");
    }
    const found = findSecretKeyName(value, [...prefix, key]);
    if (found) return found;
  }
  return null;
}

// ─── File I/O ──────────────────────────────────────────────────────────

function readManifest(): Manifest | null {
  if (!fs.existsSync(MANIFEST_FILE)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8")) as Manifest;
}

function writeManifest(m: Manifest): void {
  if (!fs.existsSync(DEMO_STATE_DIR)) fs.mkdirSync(DEMO_STATE_DIR, { recursive: true });
  const offending = findSecretKeyName(m);
  if (offending) {
    throw new Error(`Refusing to write manifest: secret-shaped key name detected at ${offending}`);
  }
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2), { mode: 0o644 });
}

function readDeploySpec(): DeploySpecFile | null {
  if (!fs.existsSync(DEPLOY_SPEC_FILE)) return null;
  return JSON.parse(fs.readFileSync(DEPLOY_SPEC_FILE, "utf-8")) as DeploySpecFile;
}

function writeDeploySpec(spec: DeploySpecFile): void {
  if (!fs.existsSync(DEMO_STATE_DIR)) fs.mkdirSync(DEMO_STATE_DIR, { recursive: true });
  fs.writeFileSync(DEPLOY_SPEC_FILE, JSON.stringify(spec, null, 2), { mode: 0o600 });
}

// ─── Customer upsert ───────────────────────────────────────────────────

async function ensureSelfCustodyOperatorCustomer(operatorPublicKey: string): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.customer.findFirst({
    where: { name: SELF_CUSTODY_OPERATOR_NAME },
  });
  if (existing) {
    if (existing.id === DEMO_DEBTOR_CUSTOMER_ID) {
      throw new Error(
        `Refusing to operate: a customer named "${SELF_CUSTODY_OPERATOR_NAME}" already exists with the Demo Debtor id. ` +
        `This script never mutates Demo Debtor. Investigate manually.`,
      );
    }
    if (existing.publicKey !== operatorPublicKey) {
      throw new Error(
        `Existing customer "${SELF_CUSTODY_OPERATOR_NAME}" (id=${existing.id}) has a different publicKey ` +
        `(${existing.publicKey.slice(0, 16)}...) than the loaded operator key. Cannot proceed without operator action.\n` +
        `       Either (a) restore your previous operator-key.json, or (b) manually clean up the existing customer + reserve.`,
      );
    }
    if (existing.signingMode !== "self-custody") {
      throw new Error(
        `Existing customer "${SELF_CUSTODY_OPERATOR_NAME}" (id=${existing.id}) has signingMode=${existing.signingMode}, ` +
        `expected "self-custody". Refusing to alter.`,
      );
    }
    return { id: existing.id, created: false };
  }
  const created = await prisma.customer.create({
    data: {
      name: SELF_CUSTODY_OPERATOR_NAME,
      publicKey: operatorPublicKey,
      privateKey: "",
      signingMode: "self-custody",
    },
  });
  return { id: created.id, created: true };
}

// ─── Phase: --prepare ──────────────────────────────────────────────────

async function phasePrepare(args: Args): Promise<number> {
  assertTestnetEnv();

  // 1. Validate args.
  if (!args.trackerNftId || !args.reserveTokenId) {
    process.stderr.write("Error: --prepare requires --tracker-nft-id and --reserve-token-id\n\n");
    printHelp();
    return 2;
  }
  if (!isHex64(args.trackerNftId)) {
    process.stderr.write("Error: --tracker-nft-id must be 64 lowercase hex chars\n");
    return 2;
  }
  if (!isHex64(args.reserveTokenId)) {
    process.stderr.write("Error: --reserve-token-id must be 64 lowercase hex chars\n");
    return 2;
  }
  const denial = checkCanonicalDenylist(null, args.reserveTokenId, args.trackerNftId);
  if (denial) {
    process.stderr.write(`Error: ${denial}. Refusing — canonical reserve must not be touched.\n`);
    return 2;
  }
  const initialCollateralNanoErg = BigInt(Math.round(args.initialCollateralErg * 1_000_000_000));
  if (initialCollateralNanoErg < COLLATERAL_FLOOR_NANO_ERG || initialCollateralNanoErg > COLLATERAL_CEILING_NANO_ERG) {
    process.stderr.write(
      `Error: --initial-collateral-erg must be between ${Number(COLLATERAL_FLOOR_NANO_ERG) / 1e9} and ${Number(COLLATERAL_CEILING_NANO_ERG) / 1e9} ERG\n`,
    );
    return 2;
  }

  // 2. Sidecar testnet pre-check.
  const health = await getSidecarHealth();
  assertSidecarTestnet(health, "phase=prepare pre-check");

  // 3. Operator key: --generate-keypair vs require existing.
  let keypair: Keypair;
  if (args.generateKeypair) {
    if (fs.existsSync(OPERATOR_KEY_FILE)) {
      process.stderr.write(
        `Error: --generate-keypair refuses to overwrite an existing key file at\n` +
        `       ${OPERATOR_KEY_FILE}.\n` +
        `       Delete it explicitly if you want a fresh key. Refusing.\n`,
      );
      return 2;
    }
    process.stderr.write(
      `WARNING — testnet-only keypair generation.\n` +
      `Generated by @noble/secp256k1 v3 (secp.utils.randomSecretKey).\n` +
      `Acceptable for a testnet demo. For mainnet, supply your own key from a wallet\n` +
      `that handles secure entropy and backup.\n\n`,
    );
    const kp = generateKeypair();
    const kf: OperatorKeyFile = {
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      generatedAt: new Date().toISOString(),
      generatedBy: "operator-reserve-init.ts --prepare --generate-keypair",
      note: "DO NOT COMMIT. Testnet operator signing key. For mainnet, replace with a key from a wallet that handles secure entropy and backup.",
    };
    if (!fs.existsSync(DEMO_STATE_DIR)) fs.mkdirSync(DEMO_STATE_DIR, { recursive: true });
    writeOperatorKey(OPERATOR_KEY_FILE, kf);
    keypair = { publicKey: kp.publicKey, privateKey: kp.privateKey };
  } else {
    if (!fs.existsSync(OPERATOR_KEY_FILE)) {
      process.stderr.write(
        `Error: ${OPERATOR_KEY_FILE} not found. Re-run with --generate-keypair, or place a\n` +
        `       valid operator-key.json under agent-tab/.demo-state/ (see docs/operator-reserve-kit.md).\n`,
      );
      return 2;
    }
    try {
      const kf = readOperatorKey(OPERATOR_KEY_FILE);
      keypair = { publicKey: kf.publicKey, privateKey: kf.privateKey };
    } catch (e) {
      process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
  }

  // 4. Keygen self-test BEFORE any DB write.
  const selfTest = await keygenSelfTest(keypair);
  if (!selfTest.ok) {
    process.stderr.write(
      `Error: keygen self-test failed. The operator key is invalid or corrupted.\n` +
      `       Aborting BEFORE any DB write.\n` +
      `       Errors:\n${selfTest.errors.map((e) => `         - ${e}`).join("\n")}\n`,
    );
    return 2;
  }

  // 5. Manifest present? — idempotency.
  const existingManifest = readManifest();
  if (existingManifest) {
    if (existingManifest.reserveTokenId !== args.reserveTokenId) {
      process.stderr.write(
        `Error: manifest already pinned to a different reserveTokenId (${existingManifest.reserveTokenId.slice(0, 16)}...).\n` +
        `       Investigate manually; --cleanup is not part of 16a-core.\n`,
      );
      return 2;
    }
    if (existingManifest.operatorPublicKey !== keypair.publicKey) {
      process.stderr.write(
        `Error: manifest's operatorPublicKey (${existingManifest.operatorPublicKey.slice(0, 16)}...) ` +
        `does not match the loaded operator key. Refusing.\n`,
      );
      return 2;
    }
    const row = await prisma.reserve.findUnique({ where: { id: existingManifest.reserveId } });
    if (!row) {
      process.stderr.write(
        `Error: manifest references missing Reserve row (id=${existingManifest.reserveId}).\n` +
        `       Resolve manually (DB row missing — likely DB reset).\n`,
      );
      return 1;
    }
    if (row.lifecycle === "active") {
      process.stdout.write(`Reserve ${row.id} already active. No-op.\n`);
      return 0;
    }
    if (row.lifecycle === "depleted") {
      process.stderr.write(
        `Error: Reserve ${row.id} is depleted. Choose a fresh reserveTokenId. ` +
        `--cleanup is not part of 16a-core.\n`,
      );
      return 2;
    }
    // requested + deploy-spec present → idempotent re-print.
    if (readDeploySpec()) {
      process.stdout.write(
        `Reserve ${row.id} registered at lifecycle=requested. Deploy spec at:\n` +
        `  ${DEPLOY_SPEC_FILE}\n` +
        `Submit the deploy tx via your Ergo wallet, then run --sync.\n`,
      );
      return 0;
    }
    // Spec lost — regenerate via direct sidecar call.
    process.stdout.write("Deploy spec missing. Regenerating from sidecar...\n");
    let regen: DeployResult;
    try {
      regen = await deployReserve({
        ownerPubKeyHex: keypair.publicKey,
        trackerNftId: existingManifest.trackerNftId,
        reserveTokenId: existingManifest.reserveTokenId,
        initialCollateralNanoErg: Number(BigInt(existingManifest.initialCollateralNanoErg)),
      });
    } catch (e) {
      process.stderr.write(`Error: sidecar deployReserve failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    assertDeployResultTestnet(regen);
    const off = findSecretKeyName(regen);
    if (off) {
      process.stderr.write(
        `Error: sidecar response contains a key that looks like a secret (${off}). ` +
        `Refusing to write deploy spec. Escalate as a sidecar bug.\n`,
      );
      return 1;
    }
    writeDeploySpec({
      kind: DEPLOY_KIND,
      deploymentRequestJson: regen.deploymentRequestJson,
      reserveAddress: regen.reserveAddress,
      scanRequestJson: regen.scanRequestJson,
      network: regen.network,
      writtenAt: new Date().toISOString(),
      writtenBy: "operator-reserve-init.ts --prepare (regenerated)",
      note: "Submit deploymentRequestJson via your Ergo testnet wallet. Do not commit; .demo-state/ is gitignored.",
    });
    process.stdout.write(`Deploy spec regenerated at ${DEPLOY_SPEC_FILE}.\n`);
    return 0;
  }

  // 6. Manifest absent — check for orphan Reserve row keyed on tokenId.
  const orphan = await prisma.reserve.findUnique({ where: { reserveTokenId: args.reserveTokenId } });
  if (orphan) {
    process.stderr.write(
      `Error: Reserve row already exists for reserveTokenId=${args.reserveTokenId.slice(0, 16)}... ` +
      `(id=${orphan.id}, customer=${orphan.customerId}, lifecycle=${orphan.lifecycle}).\n` +
      `       This is an orphan from a prior partial run. Investigate manually; 16a-core has no --cleanup.\n`,
    );
    return 2;
  }

  // 7. Fresh first run.
  // 7a. Sidecar deployReserve (non-broadcasting).
  let deployResult: DeployResult;
  try {
    deployResult = await deployReserve({
      ownerPubKeyHex: keypair.publicKey,
      trackerNftId: args.trackerNftId,
      reserveTokenId: args.reserveTokenId,
      initialCollateralNanoErg: Number(initialCollateralNanoErg),
    });
  } catch (e) {
    process.stderr.write(`Error: sidecar deployReserve failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  assertDeployResultTestnet(deployResult);
  const off = findSecretKeyName(deployResult);
  if (off) {
    process.stderr.write(
      `Error: Sidecar deployReserve response contains a key that looks like a secret (${off}). ` +
      `Refusing to persist. No DB write attempted.\n`,
    );
    return 1;
  }

  // 7b. Sign proof-of-control BEFORE any DB write.
  const pocMessage = proofOfControlMessage(args.reserveTokenId, args.trackerNftId);
  const pocSig = await signChallenge(keypair.privateKey, pocMessage);
  const pocOk = await verifyChallenge(keypair.publicKey, pocMessage, pocSig);
  if (!pocOk) {
    process.stderr.write(`Error: proof-of-control sign/verify failed locally. Aborting before DB write.\n`);
    return 2;
  }

  // 7c. Upsert Self-Custody Operator Customer.
  const customer = await ensureSelfCustodyOperatorCustomer(keypair.publicKey);

  // 7d. Derive contract version.
  const contractVersion = await deriveContractVersion(deployResult.reserveAddress);

  // 7e. Insert Reserve at lifecycle=requested.
  let newRow;
  try {
    newRow = await prisma.reserve.create({
      data: {
        customerId: customer.id,
        debtorPubKey: keypair.publicKey,
        reserveTokenId: args.reserveTokenId,
        trackerNftId: args.trackerNftId,
        reserveAddress: deployResult.reserveAddress,
        contractVersion,
        lifecycle: "requested",
      },
    });
  } catch (e) {
    process.stderr.write(`Error: prisma.reserve.create failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // 7f. Write deploy spec.
  writeDeploySpec({
    kind: DEPLOY_KIND,
    deploymentRequestJson: deployResult.deploymentRequestJson,
    reserveAddress: deployResult.reserveAddress,
    scanRequestJson: deployResult.scanRequestJson,
    network: deployResult.network,
    writtenAt: new Date().toISOString(),
    writtenBy: "operator-reserve-init.ts --prepare",
    note: "Submit deploymentRequestJson via your Ergo testnet wallet. Do not commit; .demo-state/ is gitignored.",
  });

  // 7g. Write manifest.
  const manifest: Manifest = {
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    reserveId: newRow.id,
    reserveTokenId: args.reserveTokenId,
    trackerNftId: args.trackerNftId,
    operatorCustomerId: customer.id,
    operatorPublicKey: keypair.publicKey,
    reserveAddress: deployResult.reserveAddress,
    network: deployResult.network,
    lifecycle: "requested",
    initialCollateralNanoErg: initialCollateralNanoErg.toString(),
    preparedAt: new Date().toISOString(),
    syncedAt: null,
    proofOfControl: {
      message: pocMessage,
      signature: pocSig,
      verifiedAt: new Date().toISOString(),
      verifiedAgainst: "operator-key.json",
    },
    deploySpecPath: DEPLOY_SPEC_FILE,
    note: "Local self-custodial operator reserve (slice 16a-core). Demo Debtor and the canonical reserve are not touched by this script. Not full production self-custody — see docs/operator-reserve-kit.md.",
  };
  writeManifest(manifest);

  // 7h. Print operator next steps. NEVER log the private key.
  process.stdout.write(
    `Operator reserve registered.\n` +
    `  Customer:          "${SELF_CUSTODY_OPERATOR_NAME}" (id=${customer.id}, ${customer.created ? "created" : "reused"})\n` +
    `  Reserve.id:        ${newRow.id}\n` +
    `  reserveTokenId:    ${args.reserveTokenId}\n` +
    `  trackerNftId:      ${args.trackerNftId}\n` +
    `  reserveAddress:    ${newRow.reserveAddress}\n` +
    `  operatorPublicKey: ${keypair.publicKey}\n` +
    `  network:           ${deployResult.network}\n` +
    `  lifecycle:         ${newRow.lifecycle}\n\n` +
    `Files written under agent-tab/.demo-state/ (gitignored):\n` +
    `  operator-key.json            mode 0o600\n` +
    `  operator-reserve.json        mode 0o644\n` +
    `  operator-reserve-deploy.json mode 0o600\n\n` +
    `NEXT STEPS — operator must submit the deploy tx on-chain:\n` +
    `  1. Open ${DEPLOY_SPEC_FILE}.\n` +
    `     Submit 'deploymentRequestJson' via your Ergo testnet wallet\n` +
    `     (e.g. POST /wallet/transaction/send).\n` +
    `  2. Wait for confirmation (typically 1-2 blocks).\n` +
    `  3. Run --sync to scan the reserve on-chain and transition\n` +
    `     lifecycle → active.\n\n` +
    `Run --status at any time to see DB + sidecar + deploy-spec + proof-of-control state.\n`,
  );
  return 0;
}

// ─── Phase: --sync ─────────────────────────────────────────────────────

async function phaseSync(): Promise<number> {
  assertTestnetEnv();
  const manifest = readManifest();
  if (!manifest) {
    process.stderr.write(`Error: no operator manifest at ${MANIFEST_FILE}. Run --prepare first.\n`);
    return 1;
  }
  const health = await getSidecarHealth();
  assertSidecarTestnet(health, "phase=sync pre-check");

  const row = await prisma.reserve.findUnique({ where: { id: manifest.reserveId } });
  if (!row) {
    process.stderr.write(
      `Error: manifest references missing Reserve row (id=${manifest.reserveId}); investigate manually.\n`,
    );
    return 1;
  }
  if (row.lifecycle === "active") {
    // Idempotent re-verify: re-derive proof-of-control against on-chain R4.
    const status = await getReserveStatus(manifest.reserveTokenId);
    if (status.found && status.ownerPubKey && status.ownerPubKey !== manifest.operatorPublicKey) {
      process.stderr.write(
        `Error: on-chain R4 ownerPubKey (${status.ownerPubKey.slice(0, 16)}...) ` +
        `does not match manifest's operatorPublicKey (${manifest.operatorPublicKey.slice(0, 16)}...). Refusing.\n`,
      );
      return 1;
    }
    process.stdout.write(`Reserve ${row.id} already active. Proof-of-control re-verified against on-chain R4.\n`);
    return 0;
  }
  if (row.lifecycle !== "requested") {
    process.stderr.write(
      `Error: cannot sync Reserve at lifecycle=${row.lifecycle}; expected "requested" or "active".\n`,
    );
    return 2;
  }

  let cookie: string;
  try {
    cookie = await operatorCookieHeader();
  } catch (e) {
    process.stderr.write(`Error: failed to mint operator cookie: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  let response: {
    reserve: { id: string; lifecycle: string; boxId: string | null; valueNanoErg: string; avlTreeDigest: string | null };
    onChainStatus: ReserveStatus;
    redeemability?: { redeemable: boolean; checks: Record<string, unknown> };
    note?: string;
  };
  try {
    const res = await fetch(`${AGENT_URL}/api/reserves`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ reserveId: manifest.reserveId }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      process.stderr.write(`Error: PATCH /api/reserves returned ${res.status}: ${errBody}\n`);
      return 1;
    }
    response = await res.json();
  } catch (e) {
    process.stderr.write(`Error: PATCH /api/reserves failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  if (response.reserve.lifecycle === "active") {
    // Re-verify proof-of-control against on-chain R4 owner pubkey.
    const status = response.onChainStatus;
    if (status.ownerPubKey && status.ownerPubKey !== manifest.operatorPublicKey) {
      process.stderr.write(
        `Error: on-chain R4 ownerPubKey (${status.ownerPubKey.slice(0, 16)}...) ` +
        `does not match manifest's operatorPublicKey (${manifest.operatorPublicKey.slice(0, 16)}...). Refusing.\n`,
      );
      return 1;
    }
    const updated: Manifest = {
      ...manifest,
      lifecycle: "active",
      syncedAt: new Date().toISOString(),
      proofOfControl: {
        ...manifest.proofOfControl,
        verifiedAt: new Date().toISOString(),
        verifiedAgainst: "on-chain-R4",
      },
    };
    writeManifest(updated);
    process.stdout.write(
      `Reserve ${response.reserve.id} is active.\n` +
      `  boxId:         ${response.reserve.boxId}\n` +
      `  valueNanoErg:  ${response.reserve.valueNanoErg}\n` +
      `  avlTreeDigest: ${response.reserve.avlTreeDigest ?? "(not set)"}\n` +
      `  on-chain R4 ownerPubKey matches manifest's operatorPublicKey.\n` +
      `Manifest updated.\n`,
    );
    return 0;
  }
  if (response.note && response.note.includes("not yet found on-chain")) {
    process.stderr.write(
      `Reserve not yet visible on-chain. Wait for testnet confirmation (typically 1-2 blocks) and re-run --sync.\n`,
    );
    return 1;
  }
  process.stderr.write(`Error: unexpected PATCH response: ${JSON.stringify(response)}\n`);
  return 1;
}

// ─── Phase: --status (READ-ONLY) ───────────────────────────────────────

async function phaseStatus(args: Args): Promise<number> {
  assertTestnetEnv();
  const manifest = readManifest();
  if (!manifest) {
    const out = { manifest: null, hint: "No operator manifest. Run --prepare to start." };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    if (!args.json) {
      process.stderr.write("\nNo operator manifest. Run --prepare to start.\n");
    }
    return 0;
  }
  const row = await prisma.reserve.findUnique({ where: { id: manifest.reserveId } });
  const keyFileExists = fs.existsSync(OPERATOR_KEY_FILE);
  const specExists = fs.existsSync(DEPLOY_SPEC_FILE);

  let sidecarReachable = false;
  let sidecarStatus: ReserveStatus | null = null;
  let sidecarErr: string | null = null;
  try {
    sidecarStatus = await getReserveStatus(manifest.reserveTokenId);
    sidecarReachable = true;
  } catch (e) {
    sidecarErr = e instanceof Error ? e.message : String(e);
  }

  // Re-verify proof-of-control from the manifest (READ-ONLY).
  let pocReVerify: boolean | null = null;
  try {
    pocReVerify = await verifyChallenge(
      manifest.operatorPublicKey,
      manifest.proofOfControl.message,
      manifest.proofOfControl.signature,
    );
  } catch {
    pocReVerify = false;
  }

  const onChainR4Matches = sidecarStatus && sidecarStatus.found && sidecarStatus.ownerPubKey
    ? sidecarStatus.ownerPubKey === manifest.operatorPublicKey
    : null;

  const out = {
    manifest: {
      reserveId: manifest.reserveId,
      reserveTokenId: manifest.reserveTokenId,
      trackerNftId: manifest.trackerNftId,
      operatorCustomerId: manifest.operatorCustomerId,
      operatorPublicKey: manifest.operatorPublicKey,
      reserveAddress: manifest.reserveAddress,
      network: manifest.network,
      lifecycle: manifest.lifecycle,
      preparedAt: manifest.preparedAt,
      syncedAt: manifest.syncedAt,
      deploySpecPath: manifest.deploySpecPath,
    },
    db: row
      ? {
          id: row.id,
          customerId: row.customerId,
          debtorPubKey: row.debtorPubKey,
          reserveTokenId: row.reserveTokenId,
          trackerNftId: row.trackerNftId,
          boxId: row.boxId,
          valueNanoErg: row.valueNanoErg.toString(),
          contractVersion: row.contractVersion,
          lifecycle: row.lifecycle,
          reserveAddress: row.reserveAddress,
          avlTreeDigest: row.avlTreeDigest,
        }
      : null,
    sidecar: { reachable: sidecarReachable, reserveStatus: sidecarStatus, error: sidecarErr },
    files: {
      operatorKeyFileExists: keyFileExists,
      deploySpecFileExists: specExists,
    },
    proofOfControl: {
      manifestSignatureValid: pocReVerify,
      onChainR4Matches,
    },
    hint: hintFor(row?.lifecycle, manifest, specExists),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");

  if (!args.json) {
    process.stderr.write(
      `\nOperator reserve status\n` +
      `  Reserve.id:        ${manifest.reserveId}\n` +
      `  reserveTokenId:    ${manifest.reserveTokenId.slice(0, 16)}...\n` +
      `  Lifecycle:         ${row?.lifecycle ?? "MISSING"}\n` +
      `  Sidecar:           ${sidecarReachable ? "ok" : `unreachable${sidecarErr ? ` (${sidecarErr})` : ""}`}\n` +
      `  Deploy spec:       ${specExists ? "present" : "MISSING"}\n` +
      `  Operator key file: ${keyFileExists ? "present" : "MISSING"}\n` +
      `  Proof-of-control:  manifest=${pocReVerify ?? "?"} on-chain-R4=${onChainR4Matches ?? "?"}\n` +
      `  Hint:              ${out.hint}\n\n`,
    );
  }
  return 0;
}

function hintFor(lifecycle: string | undefined, _m: Manifest, specExists: boolean): string {
  if (!lifecycle) return "Manifest references missing Reserve row. Investigate manually.";
  if (lifecycle === "active") return "Active. Settlement against the operator reserve is deferred to slice 16c.";
  if (lifecycle === "requested") {
    return specExists
      ? "Registered. Submit the deploy tx via your Ergo wallet, then run --sync."
      : "Registered but deploy spec missing. Re-run --prepare to regenerate it.";
  }
  if (lifecycle === "depleted") return "Depleted. 16a-core has no --cleanup; investigate manually.";
  return `Lifecycle "${lifecycle}" is unexpected.`;
}

// ─── main ──────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n\n`);
    printHelp();
    return 2;
  }
  if (args.phase === "help" || args.phase === null) {
    if (args.phase === null) {
      process.stderr.write("Error: a phase flag is required.\n\n");
      printHelp();
      return 2;
    }
    printHelp();
    return 0;
  }
  switch (args.phase) {
    case "prepare": return await phasePrepare(args);
    case "sync": return await phaseSync();
    case "status": return await phaseStatus(args);
  }
}

main()
  .then(async (code) => { await prisma.$disconnect(); process.exit(code); })
  .catch(async (e) => {
    process.stderr.write(`operator-reserve-init error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    process.exit(1);
  });
