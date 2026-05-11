/**
 * Operator key helpers for slice 16a-core (local operator-owned reserve mode).
 *
 * THIN WRAPPER. Does not invent new crypto.
 *
 *   generateKeypair / signChallenge / verifyChallenge route to the proven
 *   primitives in `agent-tab/src/lib/crypto.ts`, which use @noble/secp256k1 v3
 *   (the same primitive that produced every existing self-custody key in the
 *   DB — see seed-authority-demo.ts:25,111).
 *
 *   derivePublicKey calls `secp.getPublicKey(priv, true)` directly. It is used
 *   only by keygenSelfTest below, never by the script's normal happy path.
 *
 * Key material flow (16a-core scope):
 *   .demo-state/operator-key.json   ──read──▶  this helper  ──used by──▶
 *   scripts/operator-reserve-init.ts (proof-of-control signing only).
 *
 * Later slices (16c) copy `{ publicKey, privateKey }` into
 *   ~/.chaincash-secrets/owner-<hex8>.json
 * as `{ pubKeyHex, secretHex }` so the chaincash sidecar can Schnorr-sign
 * redemption txs with the same scalar.
 */

import * as fs from "fs";
import * as secp from "@noble/secp256k1";
import { generateKeypair as _generateKeypair, signMessage, verifySignature } from "@/lib/crypto";

// ─── Types ─────────────────────────────────────────────────────────────

export interface Keypair {
  publicKey: string;
  privateKey: string;
}

export interface OperatorKeyFile extends Keypair {
  generatedAt?: string;
  generatedBy?: string;
  note?: string;
}

// ─── Primitives (proxy to @/lib/crypto) ─────────────────────────────────

export function generateKeypair(): Keypair {
  return _generateKeypair();
}

export async function signChallenge(privateKeyHex: string, message: string): Promise<string> {
  return signMessage(message, privateKeyHex);
}

export async function verifyChallenge(
  publicKeyHex: string,
  message: string,
  signatureHex: string,
): Promise<boolean> {
  return verifySignature(message, signatureHex, publicKeyHex);
}

export function derivePublicKey(privateKeyHex: string): string {
  const privBytes = secp.etc.hexToBytes(privateKeyHex);
  const pubBytes = secp.getPublicKey(privBytes, true);
  return secp.etc.bytesToHex(pubBytes);
}

// ─── File I/O ───────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const HEX66 = /^[0-9a-f]{66}$/;

function assertHexShape(kf: OperatorKeyFile): void {
  if (typeof kf.publicKey !== "string" || !HEX66.test(kf.publicKey)) {
    throw new Error(
      `Invalid operator-key.json: publicKey must be a 66-char lowercase hex string ` +
      `(compressed secp256k1 pubkey).`,
    );
  }
  if (typeof kf.privateKey !== "string" || !HEX64.test(kf.privateKey)) {
    throw new Error(
      `Invalid operator-key.json: privateKey must be a 64-char lowercase hex string ` +
      `(32-byte secp256k1 scalar).`,
    );
  }
}

export function readOperatorKey(filePath: string): OperatorKeyFile {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Operator key file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed: OperatorKeyFile;
  try {
    parsed = JSON.parse(raw) as OperatorKeyFile;
  } catch (e) {
    throw new Error(`Operator key file is not valid JSON: ${filePath}`);
  }
  assertHexShape(parsed);
  return parsed;
}

export function writeOperatorKey(filePath: string, kp: OperatorKeyFile): void {
  assertHexShape(kp);
  const body = JSON.stringify(kp, null, 2);
  fs.writeFileSync(filePath, body, { mode: 0o600 });
}

// ─── Self-test (pre-DB-write gate) ─────────────────────────────────────

export interface SelfTestResult {
  ok: boolean;
  pubkeyRederivedMatches: boolean;
  signVerifyRoundtrips: boolean;
  errors: string[];
}

const SELF_TEST_MESSAGE = "agent-tab-operator-key-self-test|do-not-broadcast";

export async function keygenSelfTest(kp: Keypair): Promise<SelfTestResult> {
  const errors: string[] = [];
  let pubkeyRederivedMatches = false;
  let signVerifyRoundtrips = false;

  try {
    const derived = derivePublicKey(kp.privateKey);
    pubkeyRederivedMatches = derived === kp.publicKey;
    if (!pubkeyRederivedMatches) {
      errors.push(
        `pubkey re-derivation mismatch: stored=${kp.publicKey.slice(0, 16)}... ` +
          `derived=${derived.slice(0, 16)}...`,
      );
    }
  } catch (e) {
    errors.push(`pubkey re-derivation threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const sig = await signChallenge(kp.privateKey, SELF_TEST_MESSAGE);
    signVerifyRoundtrips = await verifyChallenge(kp.publicKey, SELF_TEST_MESSAGE, sig);
    if (!signVerifyRoundtrips) {
      errors.push("sign-then-verify on the self-test message returned false");
    }
  } catch (e) {
    errors.push(`sign/verify threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    ok: pubkeyRederivedMatches && signVerifyRoundtrips,
    pubkeyRederivedMatches,
    signVerifyRoundtrips,
    errors,
  };
}

// ─── Proof-of-control challenge ─────────────────────────────────────────

export function proofOfControlMessage(reserveTokenId: string, trackerNftId: string): string {
  return `agent-tab-operator-reserve-init|${reserveTokenId}|${trackerNftId}`;
}
