/**
 * Recursively convert BigInt values to integer-string at the JSON boundary.
 *
 * Use at the seam between Prisma objects and NextResponse.json:
 *
 *   return NextResponse.json(toJsonSafe(data));
 *
 * Why string and not Number():
 *   nanoCredit values exceed 2^53 in real usage; coercion to JS Number
 *   silently loses precision. Strings preserve the exact integer.
 *   This matches what /api/pool/summary and /api/reserves already do
 *   field-by-field (e.g. valueNanoErg.toString()).
 *
 * What this does NOT do:
 *   - It does not mutate BigInt.prototype or any other built-in.
 *   - It does not format numbers as decimal credits — that is a presentation
 *     concern. Wire format stays integer-as-string.
 *   - It does not deep-clone values it does not need to: primitives, Dates,
 *     and other "leaf" types pass through by reference. Only plain objects
 *     and arrays containing BigInt are reshaped.
 *
 * Convention: any new BigInt field returned from a route handler must be
 * routed through this helper (or stringified explicitly, as
 * /api/pool/summary does). NextResponse.json on raw Prisma rows with
 * BigInt fields will throw "Do not know how to serialize a BigInt".
 */
export function toJsonSafe<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value !== "object") return value;
  // Date, Buffer, and other class-typed values: leave as-is. JSON.stringify
  // calls Date.prototype.toJSON() so this path is correct for Dates.
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = toJsonSafe(v);
  }
  return out;
}
