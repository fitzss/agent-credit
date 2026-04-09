/**
 * Partner trust-signal gate (v0).
 *
 * The smallest possible reusable adapter seam for the rulebook's
 * "Authority eligibility / partner trust signal" first-order surface.
 *
 * - Static dispatch only — no mutable registry, no startup hooks.
 * - Binary valid/invalid result — no risk scoring, no scalar inputs.
 * - Pure in-process — no Prisma, no I/O, no DB writes.
 * - Opaque to the substrate — the substrate does not interpret signal contents.
 *
 * Adding a real partner in a later slice means appending one entry to
 * KNOWN_ISSUERS. No registration function. No lifecycle. No DI.
 */

export type TrustSignalErrorCode =
  | "UNKNOWN_ISSUER"
  | "INVALID_SIGNAL"
  | "MALFORMED_REQUEST";

export class TrustSignalError extends Error {
  code: TrustSignalErrorCode;
  constructor(message: string, code: TrustSignalErrorCode) {
    super(message);
    this.code = code;
    this.name = "TrustSignalError";
  }
}

type TrustSignalValidator = (signal: string) => Promise<boolean>;

/**
 * Hard-coded known issuers. Static dispatch — no register function.
 *
 * NOTE: `test-issuer-v0` is a v0 / private-testnet convenience used by the
 * proof stack. It accepts only the literal signal "valid-test-signal" and
 * cannot be exploited to forge any partner-meaningful credential. It is NOT
 * intended as long-term production issuer handling — when a real partner
 * ships and a production deployment becomes a concern, gate it behind a
 * NODE_ENV check. That is a v0.1 concern.
 */
const KNOWN_ISSUERS: Record<string, TrustSignalValidator> = {
  "test-issuer-v0": async (signal: string) => signal === "valid-test-signal",
};

/**
 * Validate a partner-issued eligibility signal.
 * Throws TrustSignalError on unknown issuer or invalid signal.
 * Returns void on success.
 */
export async function validateTrustSignal(
  issuerId: string,
  signal: string
): Promise<void> {
  const validator = KNOWN_ISSUERS[issuerId];
  if (!validator) {
    throw new TrustSignalError(
      `Unknown trust-signal issuer: ${issuerId}`,
      "UNKNOWN_ISSUER"
    );
  }
  const ok = await validator(signal);
  if (!ok) {
    throw new TrustSignalError(
      "Trust signal failed validation",
      "INVALID_SIGNAL"
    );
  }
}
