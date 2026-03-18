import * as secp from "@noble/secp256k1";

// secp256k1 v3 requires explicit hash configuration (uses Web Crypto API)
async function sha256(message: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(message);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
}
async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const keyCopy = new Uint8Array(key);
  const msgCopy = new Uint8Array(message);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyCopy, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msgCopy));
}
secp.hashes.sha256Async = sha256;
secp.hashes.hmacSha256Async = hmacSha256;

/**
 * Signing utilities for Agent Tab obligation state.
 *
 * Key custody model (v1): tracker-managed.
 * The tracker (this app) generates and stores keypairs on behalf of
 * providers (creditors) and customers (debtors). In a future version,
 * debtors would hold their own private keys and sign locally.
 *
 * Signature scheme: secp256k1 ECDSA (compact format).
 * Ergo uses secp256k1 Schnorr; this is the same curve, making future
 * migration to Schnorr straightforward when moving toward on-chain settlement.
 */

export function generateKeypair(): { publicKey: string; privateKey: string } {
  const privateKey = secp.utils.randomSecretKey();
  const publicKey = secp.getPublicKey(privateKey, true);
  return {
    publicKey: secp.etc.bytesToHex(publicKey),
    privateKey: secp.etc.bytesToHex(privateKey),
  };
}

/**
 * Construct the canonical obligation message.
 * Format: agentab:v1|<debtorPubKey>|<creditorPubKey>|<cumulativeAmount>|<version>|<timestamp>
 *
 * Maps to Basis's IOU note: (receiverPubKey, cumulativeDebtAmount, timestamp, signature)
 * with added version for ordering and format prefix for future compatibility.
 */
export function buildCanonicalMessage(
  debtorPubKey: string,
  creditorPubKey: string,
  cumulativeAmount: number,
  version: number,
  timestamp: string
): string {
  const amount = cumulativeAmount.toFixed(8);
  return `agentab:v1|${debtorPubKey}|${creditorPubKey}|${amount}|${version}|${timestamp}`;
}

/**
 * Sign a canonical message with the debtor's private key.
 * The library prehashes with SHA-256 internally.
 * Returns compact ECDSA signature as hex string.
 */
export async function signMessage(
  message: string,
  privateKeyHex: string
): Promise<string> {
  const msgBytes = new TextEncoder().encode(message);
  const privKeyBytes = secp.etc.hexToBytes(privateKeyHex);
  const signature = await secp.signAsync(msgBytes, privKeyBytes);
  return secp.etc.bytesToHex(signature);
}

/**
 * Verify a signature against a canonical message and public key.
 */
export async function verifySignature(
  message: string,
  signatureHex: string,
  publicKeyHex: string
): Promise<boolean> {
  try {
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = secp.etc.hexToBytes(signatureHex);
    const pubKeyBytes = secp.etc.hexToBytes(publicKeyHex);
    return await secp.verifyAsync(sigBytes, msgBytes, pubKeyBytes);
  } catch {
    return false;
  }
}
