import { prisma } from "@/lib/prisma";
import { buildCanonicalMessage, signMessage, verifySignature } from "@/lib/crypto";
import {
  buildDelegationMessage,
  verifyDelegationAuth,
  checkDelegationScope,
  verifySessionSignature,
} from "./delegation";

/**
 * TrackerService — the off-chain note/proof/status service.
 *
 * Owns: obligation state, pending/committed transitions, delegation verification,
 * proof generation, key status, note history.
 *
 * Does NOT own: agent authentication, UI, tool proxying, usage logging, credit line
 * management. Those are app-layer concerns.
 *
 * Designed as a module boundary that can be extracted into a standalone service.
 */

// --- Constants ---
const PENDING_TTL_MS = 15 * 60 * 1000; // 15 minutes — pending updates expire after this

/**
 * Denomination: 1 credit = 1 ERG = 1,000,000,000 nanoERG.
 * Used for converting between Agent Tab credit amounts and on-chain nanoERG values.
 * This is the defined exchange rate for the first redeemable implementation.
 */
export const NANOERG_PER_CREDIT = 1_000_000_000;

// --- Types ---

export interface ProposeInput {
  debtorPubKey: string;
  creditorPubKey: string;
  delta: number;
  expectedVersion: number; // optimistic concurrency — must match current version
  requestId: string; // idempotency key
  sessionPubKey?: string; // for delegated signing
  customerId?: string; // FK for obligation creation
  // Pricing context (tracker records, not just blind write)
  toolId?: string;
  toolName?: string;
  providerId?: string;
  providerName?: string;
}

export interface ProposeOutput {
  noteId: string;
  updateId: string;
  version: number;
  canonicalMessage: string;
  previousAmount: number;
  newAmount: number;
  currentAmount: number;
  pendingAmount: number;
  delegationId: string | null;
}

export interface CommitInput {
  noteId: string;
  updateId: string;
  signature: string;
  delegationId?: string;
}

export interface CommitOutput {
  noteId: string;
  version: number;
  currentAmount: number;
  pendingAmount: number;
  verified: boolean;
  delegated: boolean;
}

export interface NoteProof {
  noteId: string;
  debtorPubKey: string;
  creditorPubKey: string;
  currentAmount: number;
  pendingAmount: number;
  version: number;
  lastUpdatedAt: Date;
  canonicalMessage: string | null;
  signature: string | null;
  verified: boolean;
  signingMode: string;
  delegation: {
    delegationId: string;
    sessionPubKey: string;
    spendCap: number;
    spentSoFar: number;
    expiresAt: Date;
    delegationAuthVerified: boolean;
  } | null;
  // Reserve integration placeholders
  reserve: {
    reserveId: string | null;
    collateralizationRatio: number | null;
    latestDigest: string | null;
    commitmentRef: string | null;
  };
  debtor: string;
  creditor: string;
  settlementStatus: string;
}

export interface KeyStatus {
  publicKey: string;
  totalCommittedDebt: number;
  totalPendingDebt: number;
  noteCount: number;
  delegationCount: number;
  activeDelegations: number;
  // Reserve integration placeholders
  totalReserveValue: number | null;
  collateralizationRatio: number | null;
  notes: { noteId: string; creditorPubKey: string; currentAmount: number; pendingAmount: number; version: number }[];
}

// --- Service ---

export class TrackerService {
  /**
   * Propose a note update (charge or settlement).
   * Increases pendingAmount. Does NOT touch currentAmount.
   * For tracker-managed customers, atomically proposes + commits.
   */
  async proposeNoteUpdate(input: ProposeInput, trackerManagedPrivateKey?: string): Promise<ProposeOutput> {
    // Idempotency check: has this requestId already been processed?
    const existing = await prisma.obligationUpdate.findFirst({
      where: { nonce: input.requestId },
    });
    if (existing) {
      const note = await prisma.obligationState.findUnique({ where: { id: existing.obligationStateId } });
      return {
        noteId: existing.obligationStateId,
        updateId: existing.id,
        version: existing.version,
        canonicalMessage: existing.canonicalMessage,
        previousAmount: existing.previousAmount,
        newAmount: existing.newAmount,
        currentAmount: note?.currentAmount ?? 0,
        pendingAmount: note?.pendingAmount ?? 0,
        delegationId: existing.delegationId,
      };
    }

    // Find or create note
    const noteKey = { debtorPubKey: input.debtorPubKey, creditorPubKey: input.creditorPubKey };
    let note = await prisma.obligationState.findFirst({
      where: { debtorPubKey: noteKey.debtorPubKey, creditorPubKey: noteKey.creditorPubKey },
    });

    // Version check
    const currentVersion = note?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      throw new TrackerError(
        `Version conflict: expected ${input.expectedVersion}, current is ${currentVersion}`,
        "VERSION_CONFLICT"
      );
    }

    const newVersion = currentVersion + 1;
    const currentAmount = note?.currentAmount ?? 0;
    const pendingAmount = note?.pendingAmount ?? 0;
    const newProposedTotal = currentAmount + pendingAmount + input.delta;
    const timestamp = new Date().toISOString();

    const canonicalMessage = buildCanonicalMessage(
      input.debtorPubKey,
      input.creditorPubKey,
      newProposedTotal,
      newVersion,
      timestamp
    );

    // Check delegation if session key provided
    let delegationId: string | null = null;
    if (input.sessionPubKey) {
      const delegation = await prisma.delegation.findFirst({
        where: {
          sessionPubKey: input.sessionPubKey,
          status: "active",
          customer: { publicKey: input.debtorPubKey },
        },
      });

      if (!delegation) {
        throw new TrackerError("No active delegation for this session key", "DELEGATION_NOT_FOUND");
      }

      const scopeCheck = checkDelegationScope(
        delegation,
        input.providerId ?? "",
        input.toolId ?? "",
        input.delta
      );
      if (!scopeCheck.ok) {
        throw new TrackerError(scopeCheck.reason!, "DELEGATION_SCOPE_VIOLATED");
      }

      delegationId = delegation.id;
    }

    // For tracker-managed: propose + sign + commit atomically
    if (trackerManagedPrivateKey) {
      const signature = await signMessage(canonicalMessage, trackerManagedPrivateKey);

      if (!note) {
        note = await prisma.obligationState.create({
          data: {
            providerId: input.providerId ?? "",
            customerId: input.customerId ?? "",
            debtorPubKey: input.debtorPubKey,
            creditorPubKey: input.creditorPubKey,
            currentAmount: input.delta,
            pendingAmount: 0,
            version: newVersion,
            latestSignedMessage: canonicalMessage,
            latestSignature: signature,
          },
        });
      } else {
        note = await prisma.obligationState.update({
          where: { id: note.id },
          data: {
            currentAmount: { increment: input.delta },
            version: newVersion,
            lastUpdatedAt: new Date(),
            latestSignedMessage: canonicalMessage,
            latestSignature: signature,
          },
        });
      }

      const update = await prisma.obligationUpdate.create({
        data: {
          obligationStateId: note.id,
          delegationId,
          version: newVersion,
          previousAmount: currentAmount,
          newAmount: currentAmount + input.delta,
          delta: input.delta,
          canonicalMessage,
          signature,
          signatureStatus: "signed",
          type: input.delta >= 0 ? "charge" : "settlement",
          nonce: input.requestId,
        },
      });

      return {
        noteId: note.id,
        updateId: update.id,
        version: newVersion,
        canonicalMessage,
        previousAmount: currentAmount,
        newAmount: currentAmount + input.delta,
        currentAmount: note.currentAmount,
        pendingAmount: note.pendingAmount,
        delegationId,
      };
    }

    // Self-custody / delegated: create pending update
    if (!note) {
      note = await prisma.obligationState.create({
        data: {
          providerId: input.providerId ?? "",
          customerId: input.customerId ?? "",
          debtorPubKey: input.debtorPubKey,
          creditorPubKey: input.creditorPubKey,
          currentAmount: 0,
          pendingAmount: input.delta,
          version: newVersion,
        },
      });
    } else {
      note = await prisma.obligationState.update({
        where: { id: note.id },
        data: {
          pendingAmount: { increment: input.delta },
          version: newVersion,
          lastUpdatedAt: new Date(),
        },
      });
    }

    const update = await prisma.obligationUpdate.create({
      data: {
        obligationStateId: note.id,
        delegationId,
        version: newVersion,
        previousAmount: currentAmount,
        newAmount: currentAmount + pendingAmount + input.delta,
        delta: input.delta,
        canonicalMessage,
        signature: "",
        signatureStatus: "pending",
        type: input.delta >= 0 ? "charge" : "settlement",
        nonce: input.requestId,
      },
    });

    return {
      noteId: note.id,
      updateId: update.id,
      version: newVersion,
      canonicalMessage,
      previousAmount: currentAmount,
      newAmount: currentAmount + pendingAmount + input.delta,
      currentAmount: note.currentAmount,
      pendingAmount: note.pendingAmount,
      delegationId,
    };
  }

  /**
   * Commit a signed note update.
   * Verifies signature (root or session key), moves pending → committed.
   */
  async commitNoteUpdate(input: CommitInput): Promise<CommitOutput> {
    const update = await prisma.obligationUpdate.findUnique({ where: { id: input.updateId } });
    if (!update) {
      throw new TrackerError("Update not found", "UPDATE_NOT_FOUND");
    }
    if (update.obligationStateId !== input.noteId) {
      throw new TrackerError("Update does not belong to this note", "UPDATE_MISMATCH");
    }

    // Idempotency: already signed
    if (update.signatureStatus === "signed") {
      const note = await prisma.obligationState.findUnique({ where: { id: input.noteId } });
      return {
        noteId: input.noteId,
        version: update.version,
        currentAmount: note?.currentAmount ?? 0,
        pendingAmount: note?.pendingAmount ?? 0,
        verified: true,
        delegated: !!input.delegationId,
      };
    }

    if (update.signatureStatus !== "pending") {
      throw new TrackerError(`Update is ${update.signatureStatus}`, "UPDATE_NOT_PENDING");
    }

    // Check pending TTL
    const age = Date.now() - update.timestamp.getTime();
    if (age > PENDING_TTL_MS) {
      await this.expirePendingUpdate(update.id, input.noteId, update.delta);
      throw new TrackerError("Pending update expired (15 min TTL)", "UPDATE_EXPIRED");
    }

    const note = await prisma.obligationState.findUnique({ where: { id: input.noteId } });
    if (!note) {
      throw new TrackerError("Note not found", "NOTE_NOT_FOUND");
    }

    // Determine verification key
    let verified = false;
    if (input.delegationId) {
      const delegation = await prisma.delegation.findUnique({ where: { id: input.delegationId } });
      if (!delegation || delegation.status !== "active") {
        throw new TrackerError("Delegation not found or inactive", "DELEGATION_INVALID");
      }
      if (new Date() >= delegation.expiresAt) {
        await prisma.delegation.update({ where: { id: input.delegationId }, data: { status: "expired" } });
        throw new TrackerError("Delegation expired", "DELEGATION_EXPIRED");
      }

      verified = await verifySessionSignature(
        update.canonicalMessage,
        input.signature,
        delegation.sessionPubKey
      );

      if (!verified) {
        throw new TrackerError("Session signature verification failed", "SIGNATURE_INVALID");
      }

      // Update delegation spend
      const newSpent = delegation.spentSoFar + update.delta;
      await prisma.delegation.update({
        where: { id: input.delegationId },
        data: {
          spentSoFar: newSpent,
          status: newSpent >= delegation.spendCap ? "exhausted" : "active",
        },
      });
    } else {
      // Direct root key
      verified = await verifySignature(
        update.canonicalMessage,
        input.signature,
        note.debtorPubKey
      );

      if (!verified) {
        throw new TrackerError("Signature verification failed against debtor root key", "SIGNATURE_INVALID");
      }
    }

    // Commit: move pending → committed
    const [updatedNote] = await prisma.$transaction([
      prisma.obligationState.update({
        where: { id: input.noteId },
        data: {
          currentAmount: { increment: update.delta },
          pendingAmount: { decrement: update.delta },
          latestSignedMessage: update.canonicalMessage,
          latestSignature: input.signature,
          lastUpdatedAt: new Date(),
        },
      }),
      prisma.obligationUpdate.update({
        where: { id: input.updateId },
        data: { signature: input.signature, signatureStatus: "signed" },
      }),
    ]);

    return {
      noteId: input.noteId,
      version: update.version,
      currentAmount: updatedNote.currentAmount,
      pendingAmount: updatedNote.pendingAmount,
      verified: true,
      delegated: !!input.delegationId,
    };
  }

  /**
   * Get note proof with full verification chain.
   */
  async getNoteProof(noteId: string): Promise<NoteProof> {
    const note = await prisma.obligationState.findUnique({
      where: { id: noteId },
      include: { provider: true, customer: true },
    });
    if (!note) {
      throw new TrackerError("Note not found", "NOTE_NOT_FOUND");
    }

    const latestUpdate = await prisma.obligationUpdate.findFirst({
      where: { obligationStateId: noteId, signatureStatus: "signed" },
      orderBy: { version: "desc" },
      include: { delegation: true },
    });

    let verified = false;
    let signingMode = "tracker";
    let delegationInfo = null;

    if (note.latestSignedMessage && note.latestSignature) {
      if (latestUpdate?.delegation) {
        signingMode = "delegated";
        verified = await verifySignature(
          note.latestSignedMessage,
          note.latestSignature,
          latestUpdate.delegation.sessionPubKey
        );

        const delegationValid = await verifyDelegationAuth(
          latestUpdate.delegation.authMessage,
          latestUpdate.delegation.authSignature,
          note.debtorPubKey
        );

        delegationInfo = {
          delegationId: latestUpdate.delegation.id,
          sessionPubKey: latestUpdate.delegation.sessionPubKey,
          spendCap: latestUpdate.delegation.spendCap,
          spentSoFar: latestUpdate.delegation.spentSoFar,
          expiresAt: latestUpdate.delegation.expiresAt,
          delegationAuthVerified: delegationValid,
        };
      } else {
        signingMode = note.customer.signingMode === "self-custody" ? "self-custody" : "tracker";
        verified = await verifySignature(
          note.latestSignedMessage,
          note.latestSignature,
          note.debtorPubKey
        );
      }
    }

    return {
      noteId: note.id,
      debtorPubKey: note.debtorPubKey,
      creditorPubKey: note.creditorPubKey,
      currentAmount: note.currentAmount,
      pendingAmount: note.pendingAmount,
      version: note.version,
      lastUpdatedAt: note.lastUpdatedAt,
      canonicalMessage: note.latestSignedMessage,
      signature: note.latestSignature,
      verified,
      signingMode,
      delegation: delegationInfo,
      reserve: await this.getReserveForKey(note.debtorPubKey, note.currentAmount),
      debtor: note.customer.name,
      creditor: note.provider.name,
      settlementStatus: note.settlementStatus,
    };
  }

  /**
   * Get note history (tracker's note lifecycle, not app usage logs).
   */
  async getNoteHistory(noteId: string) {
    return prisma.obligationUpdate.findMany({
      where: { obligationStateId: noteId },
      orderBy: { version: "asc" },
      select: {
        id: true,
        version: true,
        previousAmount: true,
        newAmount: true,
        delta: true,
        canonicalMessage: true,
        signature: true,
        signatureStatus: true,
        type: true,
        nonce: true,
        delegationId: true,
        timestamp: true,
      },
    });
  }

  /**
   * Get all notes for a debtor public key.
   */
  async getNotesForKey(debtorPubKey: string) {
    return prisma.obligationState.findMany({
      where: { debtorPubKey },
      select: {
        id: true,
        creditorPubKey: true,
        currentAmount: true,
        pendingAmount: true,
        version: true,
        settlementStatus: true,
        lastUpdatedAt: true,
      },
    });
  }

  /**
   * Get key status — total debt, delegation status, reserve placeholders.
   */
  async getKeyStatus(pubKey: string): Promise<KeyStatus> {
    const notes = await prisma.obligationState.findMany({
      where: { debtorPubKey: pubKey },
      select: {
        id: true,
        creditorPubKey: true,
        currentAmount: true,
        pendingAmount: true,
        version: true,
      },
    });

    const delegations = await prisma.delegation.findMany({
      where: { customer: { publicKey: pubKey } },
    });

    // Query linked reserves
    const reserves = await prisma.reserve.findMany({
      where: { debtorPubKey: pubKey, lifecycle: "active" },
    });

    const totalDebt = notes.reduce((s, n) => s + n.currentAmount, 0);
    const totalReserveNanoErg = reserves.reduce((s, r) => s + Number(r.valueNanoErg), 0);
    // Convert nanoERG to credits using defined denomination (1 credit = 1 ERG)
    const totalReserveCredits = totalReserveNanoErg > 0 ? totalReserveNanoErg / NANOERG_PER_CREDIT : null;
    const collateralizationRatio = totalDebt > 0 && totalReserveCredits !== null
      ? totalReserveCredits / totalDebt
      : null;

    return {
      publicKey: pubKey,
      totalCommittedDebt: totalDebt,
      totalPendingDebt: notes.reduce((s, n) => s + n.pendingAmount, 0),
      noteCount: notes.length,
      delegationCount: delegations.length,
      activeDelegations: delegations.filter((d) => d.status === "active").length,
      // Reserve status — tracker-side estimate based on last known on-chain state
      totalReserveValue: totalReserveCredits,
      collateralizationRatio,
      notes: notes.map((n) => ({
        noteId: n.id,
        creditorPubKey: n.creditorPubKey,
        currentAmount: n.currentAmount,
        pendingAmount: n.pendingAmount,
        version: n.version,
      })),
    };
  }

  /**
   * Create a delegation — verify root key auth signature.
   */
  async createDelegation(input: {
    debtorPubKey: string;
    sessionPubKey: string;
    scopeProviderIds: string;
    scopeToolIds: string;
    spendCap: number;
    expiresAt: string;
    authSignature: string;
  }) {
    const authMessage = buildDelegationMessage(
      input.debtorPubKey,
      input.sessionPubKey,
      input.scopeProviderIds,
      input.scopeToolIds,
      input.spendCap,
      input.expiresAt
    );

    const verified = await verifyDelegationAuth(authMessage, input.authSignature, input.debtorPubKey);
    if (!verified) {
      throw new TrackerError("Delegation auth signature invalid", "DELEGATION_AUTH_INVALID");
    }

    const customer = await prisma.customer.findFirst({ where: { publicKey: input.debtorPubKey } });
    if (!customer) {
      throw new TrackerError("No customer found for debtor public key", "CUSTOMER_NOT_FOUND");
    }

    const delegation = await prisma.delegation.create({
      data: {
        customerId: customer.id,
        sessionPubKey: input.sessionPubKey,
        scopeProviderIds: input.scopeProviderIds,
        scopeToolIds: input.scopeToolIds,
        spendCap: input.spendCap,
        expiresAt: new Date(input.expiresAt),
        authMessage,
        authSignature: input.authSignature,
      },
    });

    return { delegationId: delegation.id, verified: true };
  }

  /**
   * Get delegations for a debtor key.
   */
  async getDelegations(debtorPubKey: string) {
    return prisma.delegation.findMany({
      where: { customer: { publicKey: debtorPubKey } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        sessionPubKey: true,
        scopeProviderIds: true,
        scopeToolIds: true,
        spendCap: true,
        spentSoFar: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Revoke a delegation.
   */
  async revokeDelegation(delegationId: string) {
    await prisma.delegation.update({
      where: { id: delegationId },
      data: { status: "revoked" },
    });
    return { revoked: true };
  }

  /**
   * Expire a pending update and reclaim pending amount.
   */
  /**
   * Get reserve info for a debtor key. Returns tracker-side estimate,
   * labeled honestly as such until real on-chain redemption is live.
   */
  private async getReserveForKey(
    debtorPubKey: string,
    noteAmount: number
  ): Promise<NoteProof["reserve"]> {
    const reserve = await prisma.reserve.findFirst({
      where: { debtorPubKey, lifecycle: "active" },
      orderBy: { valueNanoErg: "desc" },
    });

    if (!reserve) {
      return {
        reserveId: null,
        collateralizationRatio: null,
        latestDigest: null,
        commitmentRef: null,
      };
    }

    const reserveCredits = Number(reserve.valueNanoErg) / 1_000_000_000;
    return {
      reserveId: reserve.reserveTokenId,
      collateralizationRatio: noteAmount > 0 ? reserveCredits / noteAmount : null,
      latestDigest: reserve.avlTreeDigest ?? null,
      commitmentRef: reserve.boxId ?? null,
    };
  }

  private async expirePendingUpdate(updateId: string, noteId: string, delta: number) {
    await prisma.$transaction([
      prisma.obligationUpdate.update({
        where: { id: updateId },
        data: { signatureStatus: "rejected" },
      }),
      prisma.obligationState.update({
        where: { id: noteId },
        data: { pendingAmount: { decrement: delta } },
      }),
    ]);
  }
}

export class TrackerError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

// Singleton
export const tracker = new TrackerService();
