#!/usr/bin/env tsx
/**
 * seed-settlement-demo-reserve (slice 13b)
 *
 * Phased setup for a dedicated demo reserve under Demo Debtor that 13c can
 * settle against without ever touching the canonical reserve e7f6f1c2.
 *
 * Read-mostly. The only DB writes are:
 *   --prepare       inserts ONE Reserve row (via POST /api/reserves)
 *   --sync          updates that one row (via PATCH /api/reserves)
 *   --cleanup       updates that one row to lifecycle="depleted"
 *
 * No SettlementEvent, PendingRedemption, schema, chaincash, or canonical-
 * reserve mutations.
 *
 * Phases (mutually exclusive):
 *   --prepare --tracker-nft-id <hex64> --reserve-token-id <hex64>
 *               [--initial-collateral-erg <decimal>]   default 0.5
 *   --sync
 *   --status [--json]
 *   --cleanup [--reserve-token-id <hex64>]   token form is for orphan rows
 *
 * Exit codes:
 *   0  success / idempotent no-op
 *   1  recoverable failure (sidecar/node down, chain not yet visible, etc.)
 *   2  misuse / canonical-ID collision / corrupt manifest
 *
 * Manifest:    agent-tab/.demo-state/settlement-demo-reserve.json
 * Deploy spec: agent-tab/.demo-state/settlement-demo-reserve-deploy.json (mode 0o600)
 *
 * Both manifest files are gitignored at agent-tab/.gitignore (.demo-state/).
 */

import * as fs from "fs";
import * as path from "path";
import { prisma } from "@/lib/prisma";
import { deployReserve, getReserveStatus, deriveContractVersion, type DeployResult, type ReserveStatus } from "@/lib/sidecar-client";
import { operatorCookieHeader } from "./lib/test-session";

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

// Demo Debtor — the only customer this script will ever operate under.
const DEMO_DEBTOR_CUSTOMER_ID = "86c0dc8d-506b-41d8-af24-27abe58499f7";

// Canonical reserve denylist. ANY of these matched in user input → exit 2 BEFORE
// any side effect.
const CANONICAL_RESERVE_ID = "e7f6f1c2-39ec-4bfe-b06f-7c12c37fb18c";
const CANONICAL_RESERVE_TOKEN_ID = "2b700ca1aa418fdf1cbbbd98c2122ff9bf1afd7b5b2809637b5350c35c40d937";
const CANONICAL_TRACKER_NFT_ID = "d234898d01d478db47ab2073e4e5289a414be79e0ecb8670a9f4fc44d8d70f5b";

// Demo-state files — gitignored at agent-tab/.gitignore:45
const DEMO_STATE_DIR = path.join(__dirname, "..", ".demo-state");
const MANIFEST_FILE = path.join(DEMO_STATE_DIR, "settlement-demo-reserve.json");
const DEPLOY_SPEC_FILE = path.join(DEMO_STATE_DIR, "settlement-demo-reserve-deploy.json");

// Initial collateral bounds (sanity). Default is 0.5 ERG, set in parseArgs().
const COLLATERAL_FLOOR_NANO_ERG = BigInt(100_000_000);   // 0.1 ERG
const COLLATERAL_CEILING_NANO_ERG = BigInt(10_000_000_000); // 10 ERG

// Sidecar timeout for direct calls (script-local; not from sidecar-client).
const SIDECAR_TIMEOUT_MS = 5_000;

// App URL (matches the running dev server prove.sh / validate.sh expect).
const AGENT_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

// ─────────────────────────────────────────────────────────────────────────
// CLI types
// ─────────────────────────────────────────────────────────────────────────

interface Args {
  phase: "prepare" | "sync" | "status" | "cleanup" | "help" | null;
  trackerNftId: string | null;
  reserveTokenId: string | null;
  initialCollateralErg: number;
  json: boolean;
}

interface Manifest {
  reserveId: string;
  reserveTokenId: string;
  trackerNftId: string;
  customerId: string;
  initialCollateralNanoErg: string;  // BigInt as string
  preparedAt: string;
  syncedAt: string | null;
  deploySpecPath: string;
  note: string;
}

interface DeploySpecFile {
  deploymentRequestJson: unknown;
  reserveAddress: string;
  scanRequestJson?: unknown;
  network: string;
  writtenAt: string;
  writtenBy: string;
  regeneratedAt?: string;
  note: string;
}

// ─────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = {
    phase: null,
    trackerNftId: null,
    reserveTokenId: null,
    initialCollateralErg: 0.5,
    json: false,
  };
  let phaseFlagsSeen = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prepare") { args.phase = "prepare"; phaseFlagsSeen++; }
    else if (a === "--sync") { args.phase = "sync"; phaseFlagsSeen++; }
    else if (a === "--status") { args.phase = "status"; phaseFlagsSeen++; }
    else if (a === "--cleanup") { args.phase = "cleanup"; phaseFlagsSeen++; }
    else if (a === "--help" || a === "-h") { args.phase = "help"; }
    else if (a === "--json") { args.json = true; }
    else if (a === "--tracker-nft-id") {
      const v = argv[++i];
      if (!v) throw new Error("--tracker-nft-id requires a value");
      args.trackerNftId = v.toLowerCase();
    } else if (a === "--reserve-token-id") {
      const v = argv[++i];
      if (!v) throw new Error("--reserve-token-id requires a value");
      args.reserveTokenId = v.toLowerCase();
    } else if (a === "--initial-collateral-erg") {
      const v = argv[++i];
      if (!v) throw new Error("--initial-collateral-erg requires a value");
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--initial-collateral-erg must be a positive number");
      args.initialCollateralErg = n;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (phaseFlagsSeen > 1) {
    throw new Error("--prepare, --sync, --status, --cleanup are mutually exclusive");
  }
  return args;
}

function printHelp(): void {
  process.stderr.write(
    `seed-settlement-demo-reserve (slice 13b)\n\n` +
    `Phased setup of a dedicated demo reserve under Demo Debtor for receipt-to-\n` +
    `reserve settlement demos. The canonical reserve e7f6f1c2 is never touched.\n\n` +
    `Usage:\n` +
    `  --prepare --tracker-nft-id <hex64> --reserve-token-id <hex64>\n` +
    `           [--initial-collateral-erg <decimal>]    default 0.5\n` +
    `  --sync\n` +
    `  --status [--json]\n` +
    `  --cleanup [--reserve-token-id <hex64>]\n\n` +
    `Phases:\n` +
    `  --prepare   Validate, POST /api/reserves, save deploy spec + manifest.\n` +
    `              Reserve starts at lifecycle=requested.\n` +
    `              Operator must then submit the deploy tx via wallet.\n` +
    `  --sync      PATCH /api/reserves to scan from chain.\n` +
    `              Transitions requested → active when found on-chain.\n` +
    `              Exits 1 (resumable) if the tx hasn't confirmed yet.\n` +
    `  --status    Read-only. Reports DB row, sidecar status, deploy-spec\n` +
    `              presence. Never writes.\n` +
    `  --cleanup   Mark Reserve depleted, delete manifest + deploy spec.\n` +
    `              With --reserve-token-id <hex>: clean up an orphan row\n` +
    `              (DB row exists, no manifest).\n\n` +
    `Files:\n` +
    `  agent-tab/.demo-state/settlement-demo-reserve.json         (manifest)\n` +
    `  agent-tab/.demo-state/settlement-demo-reserve-deploy.json  (deploy spec, 0o600)\n\n` +
    `Exit codes: 0 success, 1 recoverable failure, 2 misuse / canonical collision.\n` +
    `Read docs/settlement-demo-reserve.md for the full operator runbook.\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Validators
// ─────────────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;

function isHex64(s: string): boolean {
  return HEX64.test(s);
}

function checkCanonicalDenylist(reserveTokenId: string | null, trackerNftId: string | null): string | null {
  if (reserveTokenId === CANONICAL_RESERVE_TOKEN_ID) return "reserveTokenId is the canonical reserve token";
  if (trackerNftId === CANONICAL_TRACKER_NFT_ID) return "trackerNftId is the canonical tracker NFT";
  return null;
}

/**
 * Recursively scan an object/array for any object KEY matching the secret-key
 * regex. Returns the dotted path to the offending key (e.g.
 * "deployment.scanRequestJson.privateKey") or null. The VALUE is never
 * inspected, returned, or logged.
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

// ─────────────────────────────────────────────────────────────────────────
// Manifest + deploy-spec I/O
// ─────────────────────────────────────────────────────────────────────────

function readManifest(): Manifest | null {
  if (!fs.existsSync(MANIFEST_FILE)) return null;
  const raw = fs.readFileSync(MANIFEST_FILE, "utf-8");
  return JSON.parse(raw) as Manifest;
}

function writeManifest(m: Manifest): void {
  if (!fs.existsSync(DEMO_STATE_DIR)) fs.mkdirSync(DEMO_STATE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2));
}

function readDeploySpec(): DeploySpecFile | null {
  if (!fs.existsSync(DEPLOY_SPEC_FILE)) return null;
  const raw = fs.readFileSync(DEPLOY_SPEC_FILE, "utf-8");
  return JSON.parse(raw) as DeploySpecFile;
}

function writeDeploySpec(spec: DeploySpecFile): void {
  if (!fs.existsSync(DEMO_STATE_DIR)) fs.mkdirSync(DEMO_STATE_DIR, { recursive: true });
  fs.writeFileSync(DEPLOY_SPEC_FILE, JSON.stringify(spec, null, 2), { mode: 0o600 });
}

// ─────────────────────────────────────────────────────────────────────────
// Sidecar timeout wrapper (script-local; sidecar-client unmodified)
// ─────────────────────────────────────────────────────────────────────────

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Phase: --prepare
// ─────────────────────────────────────────────────────────────────────────

async function phasePrepare(args: Args): Promise<number> {
  // 1. Validate args.
  if (!args.trackerNftId || !args.reserveTokenId) {
    process.stderr.write("Error: --prepare requires --tracker-nft-id and --reserve-token-id\n\n");
    printHelp();
    return 2;
  }
  if (!isHex64(args.trackerNftId)) {
    process.stderr.write(`Error: --tracker-nft-id must be 64 lowercase hex chars\n`);
    return 2;
  }
  if (!isHex64(args.reserveTokenId)) {
    process.stderr.write(`Error: --reserve-token-id must be 64 lowercase hex chars\n`);
    return 2;
  }
  const denial = checkCanonicalDenylist(args.reserveTokenId, args.trackerNftId);
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

  // 2. Manifest present?
  const manifest = readManifest();
  if (manifest) {
    if (manifest.reserveTokenId !== args.reserveTokenId) {
      process.stderr.write(
        `Error: manifest already pinned to a different reserveTokenId (${manifest.reserveTokenId.slice(0, 16)}...).\n` +
        `       Run --cleanup first or pass the matching reserveTokenId.\n`,
      );
      return 2;
    }
    // 3. Manifest matches — resolve current state.
    const row = await prisma.reserve.findUnique({ where: { id: manifest.reserveId } });
    if (!row) {
      process.stderr.write(
        `Error: Manifest references missing Reserve row (id=${manifest.reserveId}).\n` +
        `       The DB was reset or the row was deleted. Resolve manually:\n` +
        `         rm ${MANIFEST_FILE}\n` +
        `         rm -f ${DEPLOY_SPEC_FILE}\n` +
        `       Then re-run --prepare.\n`,
      );
      return 1;
    }
    if (row.lifecycle === "active") {
      process.stdout.write(`Reserve ${row.id} already active. No-op.\n`);
      return 0;
    }
    if (row.lifecycle === "depleted") {
      process.stderr.write(
        `Error: Reserve ${row.id} for tokenId ${args.reserveTokenId.slice(0, 16)}... is depleted.\n` +
        `       Choose a fresh reserveTokenId and re-run --prepare; or remove the\n` +
        `       depleted row manually first.\n`,
      );
      return 2;
    }
    // 4. Deploy-spec recovery check.
    const spec = readDeploySpec();
    if (spec) {
      process.stdout.write(
        `Reserve ${row.id} registered at lifecycle=requested. Deploy spec at:\n` +
        `  ${DEPLOY_SPEC_FILE}\n` +
        `Submit the deploy tx (see docs/settlement-demo-reserve.md), then run --sync.\n`,
      );
      return 0;
    }
    // Spec lost — regenerate via direct sidecar call.
    process.stdout.write(`Deploy spec missing. Regenerating from sidecar...\n`);
    const customer = await prisma.customer.findUnique({ where: { id: manifest.customerId } });
    if (!customer) {
      process.stderr.write(`Error: Demo Debtor customer ${manifest.customerId} missing from DB.\n`);
      return 1;
    }
    let deployResult: DeployResult;
    try {
      deployResult = await deployReserve({
        ownerPubKeyHex: customer.publicKey,
        trackerNftId: manifest.trackerNftId,
        reserveTokenId: manifest.reserveTokenId,
        initialCollateralNanoErg: Number(BigInt(manifest.initialCollateralNanoErg)),
      });
    } catch (e) {
      process.stderr.write(`Error: sidecar deployReserve failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const offendingKey = findSecretKeyName(deployResult);
    if (offendingKey) {
      process.stderr.write(
        `Error: Sidecar response contains a key that looks like a secret (${offendingKey}).\n` +
        `       Refusing to regenerate deploy spec. Manifest is preserved; resolve and\n` +
        `       re-run --prepare. Escalate as a sidecar bug.\n`,
      );
      return 1;
    }
    const regenSpec: DeploySpecFile = {
      deploymentRequestJson: deployResult.deploymentRequestJson,
      reserveAddress: deployResult.reserveAddress,
      scanRequestJson: deployResult.scanRequestJson,
      network: deployResult.network,
      writtenAt: manifest.preparedAt,
      writtenBy: "scripts/seed-settlement-demo-reserve.ts --prepare",
      regeneratedAt: new Date().toISOString(),
      note: "Deploy spec for the slice 13b dedicated demo reserve. Submit deploymentRequestJson via your Ergo wallet. Do not commit; .demo-state/ is gitignored.",
    };
    writeDeploySpec(regenSpec);
    process.stdout.write(
      `Deploy spec was missing for an existing requested reserve.\n` +
      `Regenerated from the sidecar at ${DEPLOY_SPEC_FILE} (mode 0o600).\n` +
      `Submit it via your wallet, then run --sync.\n`,
    );
    return 0;
  }

  // 2 (cont.) Manifest absent — check for orphan row.
  const existingRow = await prisma.reserve.findUnique({ where: { reserveTokenId: args.reserveTokenId } });
  if (existingRow) {
    process.stderr.write(
      `Error: Reserve row exists at lifecycle=${existingRow.lifecycle} with reserveTokenId=${args.reserveTokenId.slice(0, 16)}...\n` +
      `       but no manifest. This is an orphan row (most likely from a prior\n` +
      `       --prepare that failed after DB write). Run:\n\n` +
      `         npx tsx scripts/seed-settlement-demo-reserve.ts --cleanup --reserve-token-id ${args.reserveTokenId}\n\n` +
      `       to clear the orphan, then re-run --prepare.\n`,
    );
    return 2;
  }

  // 5+. Fresh first run.
  //
  // We bypass POST /api/reserves to avoid (a) the route's known BigInt
  // serialization bug in its 201 response (it returns a Prisma Reserve row
  // with valueNanoErg: BigInt without serializing to string, unlike the GET
  // and PATCH handlers in the same file), and (b) any need to mint an
  // operator session cookie for the create. We replicate the route's logic
  // directly: call sidecar deployReserve, derive contract version, insert
  // the Reserve row at lifecycle=requested. The PATCH route is still used
  // by --sync (it serializes correctly).

  // 6. Look up Demo Debtor (we already validated DEMO_DEBTOR_CUSTOMER_ID is in scope).
  const customer = await prisma.customer.findUnique({ where: { id: DEMO_DEBTOR_CUSTOMER_ID } });
  if (!customer) {
    process.stderr.write(`Error: Demo Debtor customer ${DEMO_DEBTOR_CUSTOMER_ID} not found in DB.\n`);
    return 1;
  }

  // 7. Direct sidecar deployReserve (non-mutating to app DB; idempotent for sidecar).
  let deployResult: DeployResult;
  try {
    deployResult = await deployReserve({
      ownerPubKeyHex: customer.publicKey,
      trackerNftId: args.trackerNftId,
      reserveTokenId: args.reserveTokenId,
      initialCollateralNanoErg: Number(initialCollateralNanoErg),
    });
  } catch (e) {
    process.stderr.write(`Error: sidecar deployReserve failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // 8. Secret-key scanner on the sidecar response. CRUCIAL: this runs BEFORE
  // any DB write, so a refusal here leaves NO orphan row.
  const offendingKey = findSecretKeyName(deployResult);
  if (offendingKey) {
    process.stderr.write(
      `Error: Sidecar deployReserve response contains a key that looks like a secret (${offendingKey}).\n` +
      `       Refusing to persist deploy spec or create Reserve row. No DB write was attempted.\n` +
      `       Escalate as a sidecar bug.\n`,
    );
    return 1;
  }

  // 9. Derive contract version from the deployed address.
  const contractVersion = await deriveContractVersion(deployResult.reserveAddress);

  // 10. Insert the Reserve row directly. Mirrors the create() in
  // src/app/api/reserves/route.ts:91-101. The @unique constraint on
  // reserveTokenId protects against duplicate inserts (the orphan-check
  // earlier in this function should already have caught any duplicate; this
  // is the last-line defense).
  let newRow;
  try {
    newRow = await prisma.reserve.create({
      data: {
        customerId: DEMO_DEBTOR_CUSTOMER_ID,
        debtorPubKey: customer.publicKey,
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

  // 11. Write deploy-spec file (mode 0o600).
  const spec: DeploySpecFile = {
    deploymentRequestJson: deployResult.deploymentRequestJson,
    reserveAddress: deployResult.reserveAddress,
    scanRequestJson: deployResult.scanRequestJson,
    network: deployResult.network,
    writtenAt: new Date().toISOString(),
    writtenBy: "scripts/seed-settlement-demo-reserve.ts --prepare",
    note: "Deploy spec for the slice 13b dedicated demo reserve. Submit deploymentRequestJson via your Ergo wallet. Do not commit; .demo-state/ is gitignored.",
  };
  writeDeploySpec(spec);

  // 12. Write manifest.
  const newManifest: Manifest = {
    reserveId: newRow.id,
    reserveTokenId: args.reserveTokenId,
    trackerNftId: args.trackerNftId,
    customerId: DEMO_DEBTOR_CUSTOMER_ID,
    initialCollateralNanoErg: initialCollateralNanoErg.toString(),
    preparedAt: new Date().toISOString(),
    syncedAt: null,
    deploySpecPath: DEPLOY_SPEC_FILE,
    note: "Slice 13b dedicated demo reserve. Not the canonical reserve. Safe to delete with --cleanup.",
  };
  writeManifest(newManifest);

  // 13. Print operator next steps.
  process.stdout.write(
    `Reserve registered.\n` +
    `  Reserve.id: ${newRow.id}\n` +
    `  reserveTokenId: ${args.reserveTokenId}\n` +
    `  trackerNftId: ${args.trackerNftId}\n` +
    `  reserveAddress: ${newRow.reserveAddress ?? "(not set)"}\n` +
    `  lifecycle: ${newRow.lifecycle}\n\n` +
    `Deploy spec saved to ${DEPLOY_SPEC_FILE}\n` +
    `  (gitignored, mode 0o600 — do not commit)\n\n` +
    `NEXT STEPS — operator must submit the deploy tx on-chain:\n` +
    `  1. Open ${DEPLOY_SPEC_FILE}. Submit the\n` +
    `     'deploymentRequestJson' payload via your Ergo wallet's transaction-submit API.\n` +
    `     See docs/settlement-demo-reserve.md for the wallet API command and the\n` +
    `     wallet-unlock prerequisites.\n` +
    `  2. Wait for confirmation (1+ blocks on testnet — typically ~2 minutes).\n` +
    `  3. Run --sync to scan the reserve on-chain and transition lifecycle → active.\n\n` +
    `Run --status at any time to see DB + sidecar state and confirm the deploy\n` +
    `spec file is still on disk.\n`,
  );
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase: --sync
// ─────────────────────────────────────────────────────────────────────────

async function phaseSync(): Promise<number> {
  const manifest = readManifest();
  if (!manifest) {
    process.stderr.write(`Error: no demo manifest at ${MANIFEST_FILE}. Run --prepare first.\n`);
    return 1;
  }
  const row = await prisma.reserve.findUnique({ where: { id: manifest.reserveId } });
  if (!row) {
    process.stderr.write(
      `Error: manifest references missing Reserve row (id=${manifest.reserveId}); re-run --prepare.\n`,
    );
    return 1;
  }
  if (row.lifecycle === "active") {
    process.stdout.write(`Reserve ${row.id} already active. No-op.\n`);
    return 0;
  }
  if (row.lifecycle !== "requested") {
    process.stderr.write(
      `Error: cannot sync a Reserve at lifecycle=${row.lifecycle}; expected "requested" or "active".\n`,
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

  // Decision: active OR not-yet-found.
  if (response.reserve.lifecycle === "active" && response.redeemability) {
    // Update manifest with syncedAt.
    const updatedManifest: Manifest = { ...manifest, syncedAt: new Date().toISOString() };
    writeManifest(updatedManifest);
    process.stdout.write(
      `Reserve ${response.reserve.id} is active.\n` +
      `  boxId: ${response.reserve.boxId}\n` +
      `  valueNanoErg: ${response.reserve.valueNanoErg}\n` +
      `  avlTreeDigest: ${response.reserve.avlTreeDigest ?? "(not set)"}\n` +
      `  redeemable: ${response.redeemability.redeemable}\n` +
      `Manifest updated with syncedAt.\n` +
      `Next: run docs/settlement-readiness.md verification:\n` +
      `  npx tsx scripts/check-settlement-readiness.ts --reserve-id ${response.reserve.id} --latest-repo-lint\n` +
      `  (Expected: FAIL with tracker-entry-missing — that is the next thing 13c will resolve.)\n`,
    );
    return 0;
  }
  if (response.note && response.note.includes("not yet found on-chain")) {
    process.stderr.write(
      `Reserve not yet visible on-chain. Wait for testnet confirmation\n` +
      `(typically 1-2 blocks) and re-run --sync. Manifest preserved; DB row\n` +
      `remains at lifecycle=requested. Resumable.\n`,
    );
    return 1;
  }

  process.stderr.write(`Error: unexpected PATCH response: ${JSON.stringify(response)}\n`);
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase: --status (READ-ONLY)
// ─────────────────────────────────────────────────────────────────────────

async function phaseStatus(args: Args): Promise<number> {
  const manifest = readManifest();
  if (!manifest) {
    const out = {
      manifest: null,
      hint: "No manifest. Run --prepare to start.",
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    if (!args.json) {
      process.stderr.write("\nNo demo manifest registered. Run --prepare to start.\n");
    }
    return 0;
  }

  const row = await prisma.reserve.findUnique({ where: { id: manifest.reserveId } });

  // Direct sidecar call — never PATCH.
  let sidecarResult: ReserveStatus | null = null;
  let sidecarErr: string | null = null;
  try {
    sidecarResult = await withTimeout(getReserveStatus(manifest.reserveTokenId), SIDECAR_TIMEOUT_MS, "sidecar /reserve/status");
  } catch (e) {
    sidecarErr = e instanceof Error ? e.message : String(e);
  }
  const sidecarReachable = sidecarResult !== null;

  const spec = readDeploySpec();
  const specPresent = spec !== null;

  const dbAndSidecarBoxIdMatch = row && sidecarResult && sidecarResult.found
    ? row.boxId === sidecarResult.boxId
    : null;
  const dbAndSidecarValueMatch = row && sidecarResult && sidecarResult.found && sidecarResult.valueNanoErg != null
    ? row.valueNanoErg === BigInt(sidecarResult.valueNanoErg)
    : null;
  const dbAndSidecarDigestMatch = row && sidecarResult && sidecarResult.found
    ? (row.avlTreeDigest ?? null) === (sidecarResult.avlTreeDigest ?? null)
    : null;

  let hint: string;
  if (!row) {
    hint = "Manifest references missing Reserve row. Resolve manually (see --prepare error message).";
  } else if (row.lifecycle === "active") {
    hint = "Active and ready. Run scripts/check-settlement-readiness.ts to confirm 13a audit reports useful FAIL until 13c is implemented.";
  } else if (row.lifecycle === "requested") {
    hint = specPresent
      ? "Registered. Submit the deploy tx using the deploy spec, then run --sync."
      : "Registered but deploy spec is missing. Re-run --prepare to regenerate it.";
  } else if (row.lifecycle === "depleted") {
    hint = "Depleted. To start a new demo, choose a fresh reserveTokenId and run --cleanup then --prepare.";
  } else {
    hint = `Lifecycle is "${row.lifecycle}" — unexpected.`;
  }

  const out = {
    manifest: {
      reserveId: manifest.reserveId,
      reserveTokenId: manifest.reserveTokenId,
      trackerNftId: manifest.trackerNftId,
      customerId: manifest.customerId,
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
          creationHeight: row.creationHeight,
          updatedAt: row.updatedAt.toISOString(),
        }
      : null,
    sidecar: {
      reachable: sidecarReachable,
      reserveStatus: sidecarResult,
      error: sidecarErr,
    },
    deploySpec: {
      fileExists: specPresent,
      filePath: DEPLOY_SPEC_FILE,
      reserveAddress: spec?.reserveAddress ?? null,
      network: spec?.network ?? null,
      writtenAt: spec?.writtenAt ?? null,
    },
    alignment: {
      dbAndSidecarBoxIdMatch,
      dbAndSidecarValueMatch,
      dbAndSidecarDigestMatch,
    },
    hint,
  };

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");

  if (!args.json) {
    const lines: string[] = ["", "Settlement demo reserve status"];
    lines.push(`  Reserve.id:    ${manifest.reserveId}`);
    lines.push(`  reserveTokenId: ${manifest.reserveTokenId.slice(0, 16)}...`);
    lines.push(`  trackerNftId:  ${manifest.trackerNftId.slice(0, 16)}...`);
    lines.push(`  Lifecycle:     ${row?.lifecycle ?? "MISSING"}`);
    lines.push(`  boxId:         ${row?.boxId ?? "(null)"}`);
    lines.push(`  valueNanoErg:  ${row?.valueNanoErg?.toString() ?? "(null)"}`);
    lines.push(`  Sidecar:       ${sidecarReachable ? "ok" : `unreachable${sidecarErr ? ` (${sidecarErr})` : ""}`}`);
    lines.push(`  Deploy spec:   ${specPresent ? `present at ${DEPLOY_SPEC_FILE}` : "MISSING"}`);
    lines.push("");
    lines.push(`  Hint: ${hint}`);
    lines.push("");
    process.stderr.write(lines.join("\n"));
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase: --cleanup (manifest path) and --cleanup --reserve-token-id (orphan)
// ─────────────────────────────────────────────────────────────────────────

async function refuseIfPendingOrSettled(reserveId: string): Promise<string | null> {
  // Direct FK: PendingRedemption.reserveId → Reserve.id. Unambiguous.
  const pending = await prisma.pendingRedemption.findFirst({ where: { reserveId } });
  if (pending) {
    return `PendingRedemption ${pending.id} (txId=${pending.txId}, status=${pending.status}) exists for this reserve. Run /api/reserves/recover-pending first or wait for in-flight tx.`;
  }
  // SettlementEvent scoped via PendingRedemption history. SettlementEvent has no
  // direct FK to Reserve; the only way an Settlement is "for this reserve" is if
  // an earlier PendingRedemption tied it to this reserve. For 13b orphans this is
  // empty (no in-flight or historical pending against the orphan). For an
  // active demo reserve that has been settled by 13c, this would catch it.
  const pendingHistory = await prisma.pendingRedemption.findMany({
    where: { reserveId },
    select: { obligationId: true },
  });
  const obligationIds = pendingHistory.map((p) => p.obligationId);
  if (obligationIds.length > 0) {
    const settled = await prisma.settlementEvent.findFirst({
      where: {
        redemptionTxId: { not: null },
        obligationStateId: { in: obligationIds },
      },
    });
    if (settled) {
      return `SettlementEvent ${settled.id} (redemptionTxId=${settled.redemptionTxId}) exists for an obligation that was previously redeemed against this reserve. Refusing to clean up — investigate before depleting.`;
    }
  }
  return null;
}

async function phaseCleanupManifest(): Promise<number> {
  const manifest = readManifest();
  if (!manifest) {
    if (fs.existsSync(DEPLOY_SPEC_FILE)) fs.unlinkSync(DEPLOY_SPEC_FILE);
    process.stdout.write(
      `No manifest found. Nothing to clean.\n` +
      `(If you have an orphan Reserve row from a failed --prepare, run\n` +
      ` --cleanup --reserve-token-id <X> to clear it.)\n`,
    );
    return 0;
  }
  const row = await prisma.reserve.findUnique({ where: { id: manifest.reserveId } });
  if (!row) {
    if (fs.existsSync(MANIFEST_FILE)) fs.unlinkSync(MANIFEST_FILE);
    if (fs.existsSync(DEPLOY_SPEC_FILE)) fs.unlinkSync(DEPLOY_SPEC_FILE);
    process.stdout.write(`Manifest referenced missing row; demo-state cleared.\n`);
    return 0;
  }
  // Defensive: refuse if customer is not Demo Debtor.
  if (row.customerId !== DEMO_DEBTOR_CUSTOMER_ID) {
    process.stderr.write(
      `Error: Refusing to clean up Reserve under customer ${row.customerId};\n` +
      `       this script only manages settlement-demo reserves under Demo Debtor.\n`,
    );
    return 2;
  }
  // Defensive: refuse if id is canonical.
  if (row.id === CANONICAL_RESERVE_ID || row.reserveTokenId === CANONICAL_RESERVE_TOKEN_ID || row.trackerNftId === CANONICAL_TRACKER_NFT_ID) {
    process.stderr.write(`Error: Refusing to clean up the canonical reserve.\n`);
    return 2;
  }
  const refusal = await refuseIfPendingOrSettled(row.id);
  if (refusal) {
    process.stderr.write(`Error: ${refusal}\n`);
    return 1;
  }
  await prisma.reserve.update({
    where: { id: row.id },
    data: { lifecycle: "depleted", valueNanoErg: BigInt(0) },
  });
  if (fs.existsSync(MANIFEST_FILE)) fs.unlinkSync(MANIFEST_FILE);
  if (fs.existsSync(DEPLOY_SPEC_FILE)) fs.unlinkSync(DEPLOY_SPEC_FILE);
  process.stdout.write(
    `Reserve ${row.id} marked depleted. Manifest and deploy spec deleted from\n` +
    `  ${DEMO_STATE_DIR}\n` +
    `On-chain UTXO box NOT swept (operator's responsibility — out of scope).\n`,
  );
  return 0;
}

async function phaseCleanupByTokenId(reserveTokenId: string): Promise<number> {
  if (!isHex64(reserveTokenId)) {
    process.stderr.write(`Error: --reserve-token-id must be 64 lowercase hex chars\n`);
    return 2;
  }
  if (reserveTokenId === CANONICAL_RESERVE_TOKEN_ID) {
    process.stderr.write(`Error: refusing to clean up the canonical reserveTokenId.\n`);
    return 2;
  }
  const row = await prisma.reserve.findUnique({ where: { reserveTokenId } });
  if (!row) {
    process.stdout.write(`No reserve found for reserveTokenId=${reserveTokenId.slice(0, 16)}.... Nothing to clean.\n`);
    return 0;
  }
  if (row.customerId !== DEMO_DEBTOR_CUSTOMER_ID) {
    process.stderr.write(
      `Error: Refusing to clean up a reserve under customer ${row.customerId};\n` +
      `       this script only manages settlement-demo reserves under Demo Debtor.\n`,
    );
    return 2;
  }
  if (row.id === CANONICAL_RESERVE_ID) {
    process.stderr.write(`Error: refusing to clean up the canonical reserve (id matched).\n`);
    return 2;
  }
  const refusal = await refuseIfPendingOrSettled(row.id);
  if (refusal) {
    process.stderr.write(`Error: ${refusal}\n`);
    return 1;
  }
  // If a manifest exists and matches this row, delegate to the manifest path
  // semantics by removing the manifest. Otherwise leave manifest alone.
  const manifest = readManifest();
  if (manifest && manifest.reserveId === row.id) {
    if (fs.existsSync(MANIFEST_FILE)) fs.unlinkSync(MANIFEST_FILE);
  }
  await prisma.reserve.update({
    where: { id: row.id },
    data: { lifecycle: "depleted", valueNanoErg: BigInt(0) },
  });
  // Best-effort: delete the deploy-spec file if its reserveAddress matches the row.
  const spec = readDeploySpec();
  if (spec && spec.reserveAddress === row.reserveAddress) {
    if (fs.existsSync(DEPLOY_SPEC_FILE)) fs.unlinkSync(DEPLOY_SPEC_FILE);
  }
  process.stdout.write(
    `Orphan reserve ${row.id} for tokenId ${reserveTokenId.slice(0, 16)}... marked depleted.\n` +
    `On-chain UTXO box NOT swept.\n`,
  );
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

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
    case "prepare":
      return await phasePrepare(args);
    case "sync":
      return await phaseSync();
    case "status":
      return await phaseStatus(args);
    case "cleanup":
      if (args.reserveTokenId) {
        return await phaseCleanupByTokenId(args.reserveTokenId);
      }
      return await phaseCleanupManifest();
  }
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (e) => {
    process.stderr.write(`seed-settlement-demo-reserve error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    try {
      await prisma.$disconnect();
    } catch {
      // ignore
    }
    process.exit(1);
  });
