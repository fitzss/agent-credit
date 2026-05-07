"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { generateKeypair, signMessage } from "@/lib/crypto";
import { buildDelegationMessage } from "@/lib/tracker/delegation";
import { formatCredits, parseCredits } from "@/lib/credits";
import {
  PoolStatusBadge,
  AuthorityModeBadge,
  StatCard,
  ObligationTable,
  DelegationTable,
  ReserveCard,
  TrackerStateCard,
  SettlementHistory,
  ActivityFeed,
  DemoQuickstart,
} from "@/components";
import type {
  ObligationRow,
  DelegationRow,
  ReserveData,
  TrackerBoxData,
  SettlementData,
  ActivityEvent,
} from "@/components";

/**
 * Single pool detail view — the primary operator control surface.
 *
 * Pool = Reserve. Everything on this page belongs to one backing pool:
 * its collateral, its obligations, and its authority grants.
 */

interface PoolHealth {
  totalReserveValueNanoErg: string;
  totalObligationsNanoCredits: string;
  coverageRatio: number | null;
  poolStatus: string;
}

interface AgentEntry {
  id: string;
  label: string;
  customerId: string;
}

interface ProviderEntry {
  id: string;
  name: string;
}

interface AuthoritySummary {
  authorityMode: string;
  activeDelegations: number;
  approachingCap: number;
  approachingExpiry: number;
  exhausted: number;
  expired: number;
  revoked: number;
}

interface Authority {
  delegations: DelegationRow[];
  summary: AuthoritySummary;
}

interface PoolSummary {
  reserves: ReserveData[];
  obligations: ObligationRow[];
  poolHealth: PoolHealth;
  authority: Authority;
  agents: AgentEntry[];
  providers: ProviderEntry[];
  tracker: TrackerBoxData[];
  settlements: SettlementData[];
  recentUsage: ActivityEvent[];
}

export default function PoolDetail() {
  const { id } = useParams<{ id: string }>();
  const [pool, setPool] = useState<PoolSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [redeemResult, setRedeemResult] = useState<{
    obligationId: string;
    success: boolean;
    message: string;
  } | null>(null);

  // Delegation controls
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createAgent, setCreateAgent] = useState("");
  const [createScope, setCreateScope] = useState("*");
  const [createCap, setCreateCap] = useState("20");
  const [createDuration, setCreateDuration] = useState("7d");
  const [createKey, setCreateKey] = useState("");
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<{
    success: boolean;
    message: string;
    sessionPubKey?: string;
    sessionPrivateKey?: string;
  } | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/pool/summary?reserveId=${id}`)
      .then((r) => r.json())
      .then(setPool);
  }, [id]);

  useEffect(load, [load]);

  const refreshReserve = async (reserveId: string) => {
    setRefreshing(true);
    try {
      await fetch("/api/reserves", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reserveId }),
      });
      load();
    } finally {
      setRefreshing(false);
    }
  };

  const redeemObligation = async (reserveId: string, obligationId: string) => {
    setRedeemingId(obligationId);
    setRedeemResult(null);
    try {
      const res = await fetch("/api/reserves/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reserveId, obligationId }),
      });
      const data = await res.json();

      if (data.phase === "complete") {
        setRedeemResult({
          obligationId,
          success: true,
          message: `Settled ${data.after?.obligation?.currentAmount !== undefined ? "— obligation now " + data.after.obligation.settlementStatus : ""}`,
        });
      } else if (data.phase === "pending") {
        setRedeemResult({
          obligationId,
          success: true,
          message: `Tx submitted (${data.txId?.substring(0, 12)}...). Use recover-pending to finalize.`,
        });
      } else if (data.error) {
        setRedeemResult({ obligationId, success: false, message: data.error });
      } else {
        setRedeemResult({ obligationId, success: true, message: "Redemption initiated" });
      }
      load();
    } catch (e) {
      setRedeemResult({
        obligationId,
        success: false,
        message: e instanceof Error ? e.message : "Request failed",
      });
    } finally {
      setRedeemingId(null);
    }
  };

  const revokeDelegation = async (delegationId: string) => {
    setRevokingId(delegationId);
    try {
      await fetch("/api/delegations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: delegationId }),
      });
      setConfirmRevokeId(null);
      load();
    } finally {
      setRevokingId(null);
    }
  };

  const createDelegation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pool || !pool.reserves[0]) return;
    const customer = pool.reserves[0].customer;
    setCreating(true);
    setCreateResult(null);
    try {
      const session = generateKeypair();
      const cap = parseCredits(createCap);
      const durationMs =
        createDuration === "24h"
          ? 24 * 3600_000
          : createDuration === "7d"
            ? 7 * 24 * 3600_000
            : 30 * 24 * 3600_000;
      const expiresAt = new Date(Date.now() + durationMs).toISOString();

      const authMessage = buildDelegationMessage(
        customer.publicKey,
        createAgent,
        session.publicKey,
        createScope,
        "*",
        cap,
        expiresAt,
      );
      const authSignature = await signMessage(authMessage, createKey);

      const res = await fetch("/api/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: customer.id,
          agentIdentityId: createAgent,
          sessionPubKey: session.publicKey,
          scopeProviderIds: createScope,
          scopeToolIds: "*",
          spendCap: cap,
          expiresAt,
          authSignature,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        setCreateResult({
          success: true,
          message: "Delegation created.",
          sessionPubKey: session.publicKey,
          sessionPrivateKey: session.privateKey,
        });
        setCreateKey("");
        setShowCreateForm(false);
        load();
      } else {
        setCreateResult({
          success: false,
          message: data.error || "Failed to create delegation",
        });
      }
    } catch (err) {
      setCreateResult({
        success: false,
        message:
          err instanceof Error
            ? err.message
            : "Signing failed — check your private key",
      });
    } finally {
      setCreating(false);
    }
  };

  if (!pool) return <div className="text-zinc-500">Loading pool...</div>;

  const { reserves, obligations, poolHealth } = pool;
  const reserve = reserves[0];
  const isSelfCustody = reserve?.customer.signingMode === "self-custody";
  const poolName = reserve ? `${reserve.customer.name} Pool` : "Pool";
  const reserveValueDisplay = formatCredits(
    BigInt(poolHealth.totalReserveValueNanoErg),
  );
  const coverageDisplay =
    poolHealth.coverageRatio === null
      ? "\u221E"
      : `${Math.round(poolHealth.coverageRatio * 100)}%`;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <Link
          href="/pool"
          className="text-sm text-zinc-500 hover:text-white transition-colors"
        >
          &larr; Pools
        </Link>
        <h1 className="text-3xl font-bold mt-2">{poolName}</h1>
        <p className="text-zinc-400 mt-1">
          Backing pool health and settlement readiness
        </p>
      </div>

      {/* Pool Health Summary Strip */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Reserve Backing" value={`${reserveValueDisplay} ERG`} />
        <StatCard
          label="Outstanding Obligations"
          value={`${formatCredits(BigInt(poolHealth.totalObligationsNanoCredits))} credits`}
        />
        <StatCard label="Coverage" value={coverageDisplay} />
        <div className="border border-zinc-800 rounded-lg p-4">
          <p className="text-sm text-zinc-500">Pool Status</p>
          <div className="mt-2">
            <PoolStatusBadge status={poolHealth.poolStatus} />
          </div>
        </div>
      </div>

      {/* Reserve Card */}
      {reserve && (
        <ReserveCard
          reserve={reserve}
          refreshing={refreshing}
          onRefresh={refreshReserve}
        />
      )}

      {/* Obligations */}
      <ObligationTable
        obligations={obligations}
        redeemingId={redeemingId}
        redeemResult={redeemResult}
        onRedeem={redeemObligation}
        onDismissResult={() => setRedeemResult(null)}
      />

      {/* Bounded-buyer demo runbook — only on the seeded authority demo pool */}
      {reserve?.id === "auth-demo-reserve-001" && <DemoQuickstart />}

      {/* Agent Authority */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold">Agent Authority</h2>
            <AuthorityModeBadge mode={pool.authority.summary.authorityMode} />
          </div>
          {isSelfCustody && !showCreateForm && (
            <button
              onClick={() => {
                setShowCreateForm(true);
                setCreateResult(null);
              }}
              className="text-sm px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
            >
              + Grant Authority
            </button>
          )}
        </div>

        {/* Create result banner (session key — shown once) */}
        {createResult && (
          <div
            className={`mb-3 px-4 py-3 rounded-lg text-sm border ${
              createResult.success
                ? "bg-green-900/20 border-green-800 text-green-400"
                : "bg-red-900/20 border-red-800 text-red-400"
            }`}
          >
            <p>{createResult.message}</p>
            {createResult.sessionPubKey && (
              <div className="mt-2 space-y-1">
                <p className="text-xs text-yellow-400 font-medium">
                  Save these keys — they are shown only once.
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">
                    Session Public Key:
                  </span>
                  <code className="text-xs font-mono break-all">
                    {createResult.sessionPubKey}
                  </code>
                  <button
                    onClick={() =>
                      navigator.clipboard.writeText(createResult.sessionPubKey!)
                    }
                    className="text-xs text-zinc-500 hover:text-white"
                  >
                    copy
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">
                    Session Private Key:
                  </span>
                  <code className="text-xs font-mono break-all">
                    {createResult.sessionPrivateKey}
                  </code>
                  <button
                    onClick={() =>
                      navigator.clipboard.writeText(
                        createResult.sessionPrivateKey!,
                      )
                    }
                    className="text-xs text-zinc-500 hover:text-white"
                  >
                    copy
                  </button>
                </div>
              </div>
            )}
            <button
              onClick={() => setCreateResult(null)}
              className="mt-2 text-xs text-zinc-500 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Create delegation form */}
        {showCreateForm && isSelfCustody && (
          <form
            onSubmit={createDelegation}
            className="border border-zinc-700 rounded-lg p-4 space-y-3 bg-zinc-900 mb-3"
          >
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">
                  Agent
                </label>
                <select
                  value={createAgent}
                  onChange={(e) => setCreateAgent(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                  required
                >
                  <option value="">Select agent...</option>
                  {pool.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">
                  Provider Scope
                </label>
                <select
                  value={createScope}
                  onChange={(e) => setCreateScope(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                >
                  <option value="*">All providers</option>
                  {pool.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">
                  Spend Cap ($)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={createCap}
                  onChange={(e) => setCreateCap(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">
                  Duration
                </label>
                <select
                  value={createDuration}
                  onChange={(e) => setCreateDuration(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                >
                  <option value="24h">24 hours</option>
                  <option value="7d">7 days</option>
                  <option value="30d">30 days</option>
                </select>
              </div>
            </div>
            <div className="border border-blue-800 rounded-lg p-3 bg-blue-900/20">
              <label className="block text-sm text-blue-400 mb-1">
                Root Private Key (hex)
              </label>
              <input
                type="password"
                value={createKey}
                onChange={(e) => setCreateKey(e.target.value)}
                placeholder="Enter your secp256k1 private key..."
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-600"
              />
              <p className="text-xs text-blue-400/60 mt-1">
                Used only in your browser to sign the delegation. Never
                transmitted.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!createKey || creating}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {creating ? "Signing..." : "Create & Sign Delegation"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreateForm(false);
                  setCreateKey("");
                }}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {pool.authority.summary.authorityMode === "tracker-managed" &&
        !isSelfCustody ? (
          <div className="border border-zinc-800 rounded-lg px-5 py-6 text-center">
            <p className="text-zinc-400 text-sm">
              No delegated authority grants for this pool — obligations are
              tracker-managed.
            </p>
            <p className="text-zinc-600 text-xs mt-2">
              Delegations require a self-custody customer. This pool&apos;s
              signing authority is held by the tracker.
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-zinc-400 mb-3">
              {pool.authority.summary.activeDelegations} active delegation
              {pool.authority.summary.activeDelegations !== 1 ? "s" : ""}
              {pool.authority.summary.approachingCap > 0 && (
                <span className="text-yellow-400">
                  {" "}
                  ({pool.authority.summary.approachingCap} nearing cap)
                </span>
              )}
              {pool.authority.summary.approachingExpiry > 0 && (
                <span className="text-yellow-400">
                  {" "}
                  ({pool.authority.summary.approachingExpiry} nearing expiry)
                </span>
              )}
            </p>

            <DelegationTable
              delegations={pool.authority.delegations}
              revokingId={revokingId}
              confirmRevokeId={confirmRevokeId}
              onRequestRevoke={setConfirmRevokeId}
              onConfirmRevoke={revokeDelegation}
              onCancelRevoke={() => setConfirmRevokeId(null)}
            />
          </>
        )}
      </div>

      {/* Recent Agent Activity */}
      <ActivityFeed events={pool.recentUsage ?? []} />

      {/* Tracker State */}
      <TrackerStateCard tracker={pool.tracker} />

      {/* Settlement History */}
      <SettlementHistory settlements={pool.settlements} />
    </div>
  );
}
