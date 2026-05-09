// nanoCredits convention. Mirrors agent-tab/src/lib/credits.ts.
// 1 credit = 1_000_000_000 nanoCredits. Stored as BigInt; serialized as string.
export const NANOCREDITS_PER_CREDIT = 1_000_000_000n;

export function formatCredits(nano: bigint): string {
  const whole = nano / NANOCREDITS_PER_CREDIT;
  const frac = nano % NANOCREDITS_PER_CREDIT;
  if (frac === 0n) return `${whole}.00 credits`;
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${fracStr} credits`;
}

export function parseBigInt(s: string, field: string): bigint {
  if (!/^-?\d+$/.test(s)) {
    throw new Error(`${field}: expected integer string, got ${JSON.stringify(s)}`);
  }
  return BigInt(s);
}
