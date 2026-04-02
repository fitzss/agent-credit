"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

/**
 * Single pool detail view — scoped to one reserve.
 *
 * Pool = Reserve. Everything on this page belongs to one backing pool:
 * its collateral, its obligations, and its authority grants.
 */

interface Reserve {
  id: string;
  reserveTokenId: string;
  trackerNftId: string;
  valueNanoErg: string;
  lifecycle: string;
  contractVersion: string;
  avlTreeDigest: string | null;
  updatedAt: string;
  customer: { id: string; name: string; publicKey: string };
}

interface Obligation {
  id: string;
  providerId: string;
  providerName: string;
  customerId: string;
  customerName: string;
  currentAmount: number;
  version: number;
  settlementStatus: string;
  debtorPubKey: string;
  creditorPubKey: string;
  latestSignature: string | null;
  creditLimit: number | null;
  alertThreshold: number | null;
  reserveId: string | null;
  settlementReadiness: string;
}

interface PoolHealth {
  totalReserveValueNanoErg: string;
  totalObligationsCredits: number;
  coverageRatio: number | null;
  poolStatus: string;
}

interface AuthorityDelegation {
  id: string;
  customerId: string;
  customerName: string;
  sessionPubKey: string;
  scopeProviders: string;
  scopeTools: string;
  spendCap: number;
  spentSoFar: number;
  utilization: number;
  expiresAt: string;
  timeRemainingMs: number;
  status: string;
  complianceState: string;
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
  delegations: AuthorityDelegation[];
  summary: AuthoritySummary;
}

interface PoolSummary {
  reserves: Reserve[];
  obligations: Obligation[];
  poolHealth: PoolHealth;
  authority: Authority;
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

  if (!pool) return <div className="text-zinc-500">Loading pool...</div>;

  const { reserves, obligations, poolHealth } = pool;
  const reserve = reserves[0];
  const poolName = reserve ? `${reserve.customer.name} Pool` : "Pool";
  const reserveValueErg =
    Number(BigInt(poolHealth.totalReserveValueNanoErg)) / 1e9;
  const coverageDisplay =
    poolHealth.coverageRatio === null
      ? "∞"
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

      {/* Pool Health Banner */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Reserve Value" value={`${reserveValueErg.toFixed(2)} ERG`} />
        <StatCard
          label="Total Obligations"
          value={`${poolHealth.totalObligationsCredits.toFixed(2)} credits`}
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
        <div className="border border-zinc-800 rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">Reserve</h2>
              <LifecycleBadge lifecycle={reserve.lifecycle} />
              <VersionBadge version={reserve.contractVersion} />
            </div>
            <button
              onClick={() => refreshReserve(reserve.id)}
              disabled={refreshing}
              className="text-sm px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {refreshing ? "Refreshing..." : "Refresh from Chain"}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-zinc-500">Value</p>
              <p className="font-mono">
                {(Number(BigInt(reserve.valueNanoErg)) / 1e9).toFixed(2)} ERG
              </p>
            </div>
            <div>
              <p className="text-zinc-500">Token</p>
              <p className="font-mono text-zinc-400">
                {reserve.reserveTokenId.substring(0, 16)}...
              </p>
            </div>
            <div>
              <p className="text-zinc-500">Customer</p>
              <p>
                <Link
                  href={`/customer/${reserve.customer.id}`}
                  className="text-blue-400 hover:underline"
                >
                  {reserve.customer.name}
                </Link>
              </p>
            </div>
          </div>
          <p className="text-xs text-zinc-600">
            Last synced {new Date(reserve.updatedAt).toLocaleString()}
          </p>
        </div>
      )}

      {/* Obligations Table */}
      <div>
        <h2 className="text-xl font-semibold mb-3">Obligations</h2>

        {redeemResult && (
          <div
            className={`mb-3 px-4 py-3 rounded-lg text-sm border ${
              redeemResult.success
                ? "bg-green-900/20 border-green-800 text-green-400"
                : "bg-red-900/20 border-red-800 text-red-400"
            }`}
          >
            {redeemResult.message}
            <button
              onClick={() => setRedeemResult(null)}
              className="ml-3 text-zinc-500 hover:text-white"
            >
              &times;
            </button>
          </div>
        )}

        <div className="border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-500">
                <th className="px-4 py-3 font-medium">Provider</th>
                <th className="px-4 py-3 font-medium">Balance</th>
                <th className="px-4 py-3 font-medium">Limit</th>
                <th className="px-4 py-3 font-medium">Utilization</th>
                <th className="px-4 py-3 font-medium">Version</th>
                <th className="px-4 py-3 font-medium">Readiness</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {obligations.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-zinc-600">
                    No obligations in this pool
                  </td>
                </tr>
              ) : (
                obligations.map((o) => {
                  const utilization =
                    o.creditLimit && o.creditLimit > 0
                      ? (o.currentAmount / o.creditLimit) * 100
                      : 0;
                  const isRedeeming = redeemingId === o.id;

                  return (
                    <tr
                      key={o.id}
                      className="border-b border-zinc-800/50 hover:bg-zinc-900/50 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/provider/${o.providerId}`}
                          className="text-blue-400 hover:underline"
                        >
                          {o.providerName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono">
                        {o.currentAmount.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 font-mono text-zinc-400">
                        {o.creditLimit !== null ? o.creditLimit.toFixed(2) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        {o.creditLimit !== null && o.creditLimit > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  utilization >= 90
                                    ? "bg-red-500"
                                    : utilization >= 70
                                      ? "bg-yellow-500"
                                      : "bg-green-500"
                                }`}
                                style={{ width: `${Math.min(utilization, 100)}%` }}
                              />
                            </div>
                            <span className="text-xs text-zinc-500">
                              {Math.round(utilization)}%
                            </span>
                          </div>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/obligation/${o.id}`}
                          className="font-mono text-zinc-400 hover:text-white transition-colors"
                        >
                          v{o.version}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <ReadinessBadge readiness={o.settlementReadiness} />
                      </td>
                      <td className="px-4 py-3">
                        {o.settlementReadiness === "ready" && o.reserveId && (
                          <button
                            onClick={() => redeemObligation(o.reserveId!, o.id)}
                            disabled={isRedeeming}
                            className="text-sm px-3 py-1 bg-green-900/50 text-green-400 border border-green-800 rounded hover:bg-green-900 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            {isRedeeming ? "Redeeming..." : "Redeem"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Agent Authority */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-xl font-semibold">Agent Authority</h2>
          <AuthorityModeBadge mode={pool.authority.summary.authorityMode} />
        </div>

        {pool.authority.summary.authorityMode === "tracker-managed" ? (
          <div className="border border-zinc-800 rounded-lg px-5 py-6 text-center">
            <p className="text-zinc-400 text-sm">
              No delegated authority grants for this pool — obligations are
              tracker-managed.
            </p>
            <p className="text-zinc-600 text-xs mt-2">
              The pool operator holds signing authority directly. Agent
              obligations are committed via the tracker without per-agent
              delegation scopes or spend caps.
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-zinc-400 mb-3">
              {pool.authority.summary.activeDelegations} active delegation
              {pool.authority.summary.activeDelegations !== 1 ? "s" : ""}
              {pool.authority.summary.approachingCap > 0 && (
                <span className="text-yellow-400">
                  {" "}({pool.authority.summary.approachingCap} approaching cap)
                </span>
              )}
              {pool.authority.summary.approachingExpiry > 0 && (
                <span className="text-yellow-400">
                  {" "}({pool.authority.summary.approachingExpiry} approaching expiry)
                </span>
              )}
            </p>

            <div className="border border-zinc-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-left text-zinc-500">
                    <th className="px-4 py-3 font-medium">Session Key</th>
                    <th className="px-4 py-3 font-medium">Scope</th>
                    <th className="px-4 py-3 font-medium">Spend Cap</th>
                    <th className="px-4 py-3 font-medium">Spent</th>
                    <th className="px-4 py-3 font-medium">Utilization</th>
                    <th className="px-4 py-3 font-medium">Expires</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.authority.delegations.map((d) => (
                    <tr
                      key={d.id}
                      className="border-b border-zinc-800/50 hover:bg-zinc-900/50 transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-zinc-400">
                        {d.sessionPubKey.substring(0, 16)}...
                      </td>
                      <td className="px-4 py-3 text-zinc-300">
                        <span className="block">{d.scopeProviders}</span>
                        {d.scopeTools !== "All tools" && (
                          <span className="block text-xs text-zinc-500">
                            {d.scopeTools}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono">${d.spendCap.toFixed(2)}</td>
                      <td className="px-4 py-3 font-mono">${d.spentSoFar.toFixed(2)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                d.utilization >= 0.9
                                  ? "bg-red-500"
                                  : d.utilization >= 0.7
                                    ? "bg-yellow-500"
                                    : "bg-green-500"
                              }`}
                              style={{ width: `${Math.min(d.utilization * 100, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-zinc-500">
                            {Math.round(d.utilization * 100)}%
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-zinc-400">
                        <TimeRemaining ms={d.timeRemainingMs} />
                      </td>
                      <td className="px-4 py-3">
                        <ComplianceBadge state={d.complianceState} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Phase note */}
      <p className="text-xs text-zinc-600 border-t border-zinc-800/50 pt-4">
        Phase 1a+b: Pool settlement + authority visibility. Tracker state,
        settlement history, and delegation management are planned for subsequent
        phases.
      </p>
    </div>
  );
}

/* ---- Inline components ---- */

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-zinc-800 rounded-lg p-4">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="text-2xl font-mono mt-1">{value}</p>
    </div>
  );
}

function PoolStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    healthy: "bg-green-900/50 text-green-400",
    "low-coverage": "bg-yellow-900/50 text-yellow-400",
    depleted: "bg-red-900/50 text-red-400",
    offline: "bg-zinc-800 text-zinc-400",
  };
  const labels: Record<string, string> = {
    healthy: "Healthy",
    "low-coverage": "Low Coverage",
    depleted: "Depleted",
    offline: "Offline",
  };
  return (
    <span className={`inline-block px-2.5 py-1 text-sm rounded-full font-medium ${styles[status] || styles.offline}`}>
      {labels[status] || status}
    </span>
  );
}

function ReadinessBadge({ readiness }: { readiness: string }) {
  const styles: Record<string, string> = {
    ready: "bg-green-900/50 text-green-400",
    "no-debt": "bg-zinc-800 text-zinc-400",
    "pending-redemption": "bg-yellow-900/50 text-yellow-400",
    "insufficient-reserve": "bg-red-900/50 text-red-400",
    "reserve-inactive": "bg-zinc-800 text-zinc-400",
  };
  const labels: Record<string, string> = {
    ready: "Ready",
    "no-debt": "No Debt",
    "pending-redemption": "Pending Tx",
    "insufficient-reserve": "Insufficient Reserve",
    "reserve-inactive": "Reserve Inactive",
  };
  return (
    <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${styles[readiness] || styles["no-debt"]}`}>
      {labels[readiness] || readiness}
    </span>
  );
}

function LifecycleBadge({ lifecycle }: { lifecycle: string }) {
  const styles: Record<string, string> = {
    active: "bg-green-900/50 text-green-400",
    requested: "bg-zinc-800 text-zinc-400",
    submitted: "bg-yellow-900/50 text-yellow-400",
    depleted: "bg-red-900/50 text-red-400",
  };
  return (
    <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${styles[lifecycle] || "bg-zinc-800 text-zinc-400"}`}>
      {lifecycle}
    </span>
  );
}

function VersionBadge({ version }: { version: string }) {
  const isV2 = version === "v2";
  return (
    <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${isV2 ? "bg-blue-900/50 text-blue-400" : "bg-zinc-800 text-zinc-400"}`}>
      {version}
    </span>
  );
}

function AuthorityModeBadge({ mode }: { mode: string }) {
  if (mode === "delegated") {
    return (
      <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-blue-900/50 text-blue-400">
        Delegated Authority
      </span>
    );
  }
  return (
    <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-zinc-800 text-zinc-400">
      Tracker-Managed
    </span>
  );
}

function ComplianceBadge({ state }: { state: string }) {
  const styles: Record<string, string> = {
    active: "bg-green-900/50 text-green-400",
    "approaching-cap": "bg-yellow-900/50 text-yellow-400",
    "approaching-expiry": "bg-yellow-900/50 text-yellow-400",
    exhausted: "bg-red-900/50 text-red-400",
    expired: "bg-red-900/50 text-red-400",
    revoked: "bg-zinc-800 text-zinc-400",
  };
  const labels: Record<string, string> = {
    active: "Active",
    "approaching-cap": "Approaching Cap",
    "approaching-expiry": "Approaching Expiry",
    exhausted: "Exhausted",
    expired: "Expired",
    revoked: "Revoked",
  };
  return (
    <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${styles[state] || styles.revoked}`}>
      {labels[state] || state}
    </span>
  );
}

function TimeRemaining({ ms }: { ms: number }) {
  if (ms <= 0) return <span className="text-red-400">Expired</span>;
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days > 0) return <span>{days}d {remainingHours}h</span>;
  if (hours > 0) {
    const mins = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    return <span>{hours}h {mins}m</span>;
  }
  const mins = Math.floor(ms / (1000 * 60));
  return <span className="text-yellow-400">{mins}m</span>;
}
