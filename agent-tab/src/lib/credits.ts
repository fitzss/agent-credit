/**
 * Canonical credit denomination utilities.
 *
 * Off-chain amounts are stored as BigInt nanoCredits.
 * 1 credit = 1,000,000,000 nanoCredits.
 *
 * v1 settlement conversion: 1 nanoCredit = 1 nanoERG (identity).
 * The conversion function exists so the boundary is named and locatable.
 * A future protocol phase can change the ratio by updating one constant.
 */

/** 1 credit = 1e9 nanoCredits. The single canonical constant. */
export const NANOCREDITS_PER_CREDIT = BigInt(1_000_000_000);

/**
 * Format nanoCredits as a human-readable decimal string.
 * BigInt(100_000_000) → "0.10"
 * BigInt(20_000_000_000) → "20.00"
 * BigInt(0) → "0.00"
 */
export function formatCredits(nano: bigint): string {
  const isNeg = nano < BigInt(0);
  const abs = isNeg ? -nano : nano;
  const whole = abs / NANOCREDITS_PER_CREDIT;
  const frac = abs % NANOCREDITS_PER_CREDIT;
  const fracStr = frac.toString().padStart(9, "0");
  // Trim trailing zeros but keep at least 2 decimal places
  let trimmed = fracStr.replace(/0+$/, "");
  if (trimmed.length < 2) trimmed = fracStr.slice(0, 2);
  return `${isNeg ? "-" : ""}${whole}.${trimmed}`;
}

/**
 * Parse a human-readable decimal string to nanoCredits (BigInt).
 *
 * Strict syntax/precision parser:
 * - Accepts: /^\d+(\.\d{1,9})?$/
 * - Always returns non-negative BigInt
 * - Rejects: negatives, scientific notation, commas, currency symbols,
 *   underscores, >9 decimal digits, bare decimal, non-numeric, JS numbers
 * - Implementation: pure string→integer, no parseFloat, no IEEE 754
 *
 * Sign and zero enforcement are route-level business rules, not parser concerns.
 */
export function parseCredits(input: string): bigint {
  if (typeof input !== "string") {
    throw new Error("parseCredits requires a string input");
  }
  if (!/^\d+(\.\d{1,9})?$/.test(input)) {
    throw new Error(
      `Invalid credit amount: "${input}". Expected a non-negative decimal with up to 9 decimal places.`
    );
  }
  const parts = input.split(".");
  const whole = parts[0];
  const frac = (parts[1] || "").padEnd(9, "0");
  return BigInt(whole + frac);
}

/**
 * v1 settlement conversion: nanoCredits → nanoERG.
 * Identity in v1 (1:1). The function exists so the boundary is named.
 */
export function nanoCreditsToNanoErg(nano: bigint): bigint {
  return nano; // v1: identity
}
