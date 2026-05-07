"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { formatCredits } from "@/lib/credits";

interface AgentIdentity {
  id: string;
  label: string;
  apiKeyPreview: string | null;
  allowedToolIds: string;
  status: string;
}

interface PendingSignature {
  id: string;                    // updateId
  obligationStateId: string;     // obligationId
  canonicalMessage: string;
  delta: string;                 // BigInt nanoCredits, serialised as string
  newAmount: string;             // BigInt nanoCredits, serialised as string
  type: string;                  // "charge" | "settlement"
  delegationId: string | null;
  agentIdentityId: string | null;
  timestamp: string;
  obligationState: {
    id: string;
    providerId: string;
    provider: { id: string; name: string };
  };
}

interface CreditLine {
  id: string;
  providerId: string;
  limitAmount: string;
  alertThreshold: number;
  status: string;
  provider: { id: string; name: string };
}

interface Obligation {
  id: string;
  providerId: string;
  currentAmount: string;
  version: number;
  settlementStatus: string;
  latestSignature: string | null;
  lastUpdatedAt: string;
}

interface UsageEvent {
  id: string;
  providerId: string;
  amountCharged: string;
  timestamp: string;
  outcome: string;
  tool: { name: string };
  agentIdentity: { label: string };
}

interface ToolInfo {
  id: string;
  name: string;
  description: string;
  costPerCall: string;
  status: string;
  providerId: string;
  provider: { name: string };
}

interface Customer {
  id: string;
  name: string;
  publicKey: string;
  signingMode: string;
  contactEmail: string | null;
  agentIdentities: AgentIdentity[];
  creditLines: CreditLine[];
  obligationStates: Obligation[];
}

export default function CustomerDashboard() {
  const { id } = useParams<{ id: string }>();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [usage, setUsage] = useState<UsageEvent[]>([]);
  const [settling, setSettling] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);

  // Agent form
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [agentLabel, setAgentLabel] = useState("");
  const [lastCreatedApiKey, setLastCreatedApiKey] = useState<string | null>(null);
  const [lastKeyContext, setLastKeyContext] = useState<"created" | "rotated" | null>(null);

  // Per-card lifecycle state for Revoke / Reactivate / Rotate buttons
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [confirmRotateId, setConfirmRotateId] = useState<string | null>(null);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Record<string, string>>({});

  // Self-custody pending signatures: each pending ObligationUpdate is one card
  // in the panel. Signatures are produced externally and pasted in. The UI
  // never sees a private key.
  const [pendingSignatures, setPendingSignatures] = useState<PendingSignature[]>([]);
  const [signatureInput, setSignatureInput] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    fetch("/api/customers")
      .then((r) => r.json())
      .then((all: Customer[]) => setCustomer(all.find((c) => c.id === id) || null));
    fetch(`/api/usage?customerId=${id}`)
      .then((r) => r.json())
      .then(setUsage);
    fetch("/api/tools")
      .then((r) => r.json())
      .then(setTools);
  }, [id]);

  useEffect(load, [load]);

  const settle = async (providerId: string, amount: bigint) => {
    setSettling(providerId);
    await fetch("/api/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, customerId: id, amount: amount.toString(), method: "manual" }),
    });
    load();
    setSettling(null);
  };

  const createAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentLabel.trim()) return;
    const res = await fetch("/api/agent-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: id, label: agentLabel }),
    });
    if (res.ok) {
      const created = await res.json();
      if (typeof created?.apiKey === "string") {
        // One-time display: held in component memory only. Not persisted.
        setLastCreatedApiKey(created.apiKey);
        setLastKeyContext("created");
      }
    }
    setAgentLabel("");
    setShowAgentForm(false);
    load();
  };

  const clearAgentError = (agentId: string) => {
    setActionError((m) => {
      if (!(agentId in m)) return m;
      const next = { ...m };
      delete next[agentId];
      return next;
    });
  };

  const patchAgentStatus = async (
    agentId: string,
    status: "active" | "revoked",
  ) => {
    setActingOnId(agentId);
    clearAgentError(agentId);
    try {
      const res = await fetch(`/api/agent-identities/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      setConfirmRevokeId((id) => (id === agentId ? null : id));
      load();
    } catch (e) {
      setActionError((m) => ({ ...m, [agentId]: (e as Error).message }));
    } finally {
      setActingOnId(null);
    }
  };

  const rotateAgentKey = async (agentId: string) => {
    setActingOnId(agentId);
    clearAgentError(agentId);
    try {
      const res = await fetch(`/api/agent-identities/${agentId}/rotate`, {
        method: "POST",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (typeof data?.apiKey === "string") {
        // One-time display: held in component memory only. Not persisted.
        setLastCreatedApiKey(data.apiKey);
        setLastKeyContext("rotated");
      }
      setConfirmRotateId((id) => (id === agentId ? null : id));
      load();
    } catch (e) {
      setActionError((m) => ({ ...m, [agentId]: (e as Error).message }));
    } finally {
      setActingOnId(null);
    }
  };

  const copyKeyToClipboard = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
    } catch {
      // Clipboard write rejected (permissions/insecure context).
      // Fail silently — user still has the key visible to copy manually.
    }
  };

  const fetchPendingSignatures = useCallback(async () => {
    if (!customer || customer.signingMode !== "self-custody") {
      setPendingSignatures([]);
      return;
    }
    try {
      const res = await fetch(`/api/customers/${id}/pending-signatures`);
      if (!res.ok) {
        setPendingSignatures([]);
        return;
      }
      const data = await res.json();
      setPendingSignatures(Array.isArray(data) ? (data as PendingSignature[]) : []);
    } catch {
      setPendingSignatures([]);
    }
  }, [customer, id]);

  useEffect(() => {
    fetchPendingSignatures();
  }, [fetchPendingSignatures]);

  const submitSignature = async (row: PendingSignature) => {
    const sig = (signatureInput[row.id] ?? "").trim();
    if (!sig) {
      setSubmitError((m) => ({ ...m, [row.id]: "Signature is required" }));
      return;
    }
    setSubmittingId(row.id);
    setSubmitError((m) => {
      if (!(row.id in m)) return m;
      const next = { ...m };
      delete next[row.id];
      return next;
    });
    try {
      const body: { signature: string; updateId: string; delegationId?: string } = {
        signature: sig,
        updateId: row.id,
      };
      if (row.delegationId) body.delegationId = row.delegationId;
      const res = await fetch(`/api/obligations/${row.obligationStateId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      // Success: clear that row's input and refresh both pending list and
      // customer state. The signed row will disappear from pendingSignatures.
      setSignatureInput((m) => {
        const next = { ...m };
        delete next[row.id];
        return next;
      });
      await fetchPendingSignatures();
      load();
    } catch (e) {
      setSubmitError((m) => ({ ...m, [row.id]: (e as Error).message }));
    } finally {
      setSubmittingId(null);
    }
  };

  if (!customer) return <div className="text-zinc-500">Loading...</div>;

  const totalOwed = customer.obligationStates.reduce((s, o) => s + BigInt(o.currentAmount), BigInt(0));
  const totalLimit = customer.creditLines.reduce((s, l) => s + BigInt(l.limitAmount), BigInt(0));
  const totalRemaining = totalLimit - totalOwed;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm text-zinc-500 hover:text-white transition-colors">
          &larr; Back
        </Link>
        <h1 className="text-3xl font-bold mt-2">{customer.name}</h1>
        <p className="text-xs font-mono text-zinc-500 mt-1">{customer.publicKey}</p>
        <div className="flex items-center gap-2 mt-1">
          <p className="text-zinc-400">Customer Dashboard</p>
          <span className={`text-xs px-2 py-0.5 rounded ${
            customer.signingMode === "self-custody"
              ? "bg-blue-900/50 text-blue-400 border border-blue-800"
              : "bg-zinc-800 text-zinc-400"
          }`}>
            {customer.signingMode === "self-custody" ? "Self-Custody" : "Tracker-Managed"}
          </span>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Current Balance" value={`$${formatCredits(totalOwed)}`} highlight />
        <StatCard label="Total Limit" value={`$${formatCredits(totalLimit)}`} />
        <StatCard label="Remaining" value={`$${formatCredits(totalRemaining)}`} />
        <StatCard label="Agents" value={customer.agentIdentities.length.toString()} />
      </div>

      {/* Utilization Bar */}
      {totalLimit > BigInt(0) && (
        <div>
          {(() => {
            const utilRatio = Number(totalOwed) / Number(totalLimit);
            return (
              <>
                <div className="flex justify-between text-sm text-zinc-400 mb-1">
                  <span>Credit Utilization</span>
                  <span>{(utilRatio * 100).toFixed(0)}%</span>
                </div>
                <div className="h-3 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      utilRatio >= 0.9
                        ? "bg-red-500"
                        : utilRatio >= 0.7
                          ? "bg-yellow-500"
                          : "bg-green-500"
                    }`}
                    style={{ width: `${Math.min(utilRatio * 100, 100)}%` }}
                  />
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Run a Tool on Credit — informational card */}
      {customer.agentIdentities.length > 0 && tools.length > 0 && (
        <div className="border border-zinc-700 rounded-lg p-5 bg-zinc-900/50">
          <h2 className="text-xl font-semibold mb-2">Run a Tool on Credit</h2>
          <p className="text-sm text-zinc-400">
            Raw agent API keys are only shown once at agent creation. To call{" "}
            <code className="font-mono text-xs">/api/proxy</code> from this dashboard a future
            build will provide a &ldquo;reveal key&rdquo; flow. For now, use the API key
            copied at creation time, or run the bounded-buyer demo
            (<code className="font-mono text-xs">bash scripts/demo-bounded-buyer.sh</code>),
            which exercises the full proxy flow end-to-end.
          </p>
        </div>
      )}

      {/* Pending Signatures — self-custody only */}
      {customer.signingMode === "self-custody" && (
        <div data-testid="pending-signatures-panel">
          <h2 className="text-xl font-semibold mb-3">Pending Signatures</h2>
          {pendingSignatures.length === 0 ? (
            <div className="border border-dashed border-zinc-700 rounded-lg p-6 text-center text-zinc-500 text-sm">
              No pending signatures.
            </div>
          ) : (
            <div className="space-y-3">
              {pendingSignatures.map((row) => {
                const isSubmitting = submittingId === row.id;
                const err = submitError[row.id];
                const sigVal = signatureInput[row.id] ?? "";
                const deltaBig = BigInt(row.delta);
                const newAmtBig = BigInt(row.newAmount);
                return (
                  <div
                    key={row.id}
                    data-testid={`pending-card-${row.id}`}
                    className="border border-blue-800 rounded-lg p-5 bg-blue-900/20 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-medium text-blue-200">
                          {row.type === "settlement" ? "Settlement" : "Charge"} for{" "}
                          {row.obligationState.provider.name} — ${formatCredits(deltaBig)}
                        </h3>
                        <p className="text-xs text-zinc-400 mt-1">
                          Agent:{" "}
                          <span className="font-mono">
                            {customer.agentIdentities.find((a) => a.id === row.agentIdentityId)?.label ?? "—"}
                          </span>{" "}
                          · {new Date(row.timestamp).toLocaleString()}
                        </p>
                        <p className="text-xs text-zinc-500">
                          New balance after commit: ${formatCredits(newAmtBig)}
                        </p>
                      </div>
                    </div>

                    <div className="text-xs space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-500 w-24">Update ID:</span>
                        <span
                          data-testid={`pending-update-id-${row.id}`}
                          className="font-mono text-zinc-300 truncate"
                        >
                          {row.id}
                        </span>
                        <button
                          onClick={() => copyKeyToClipboard(row.id)}
                          className="ml-auto text-[11px] px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 rounded"
                        >
                          Copy
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-500 w-24">Obligation:</span>
                        <span className="font-mono text-zinc-400 truncate">
                          {row.obligationStateId}
                        </span>
                      </div>
                      {row.delegationId && (
                        <div className="flex items-center gap-2">
                          <span className="text-zinc-500 w-24">Delegation:</span>
                          <span className="font-mono text-zinc-400 truncate">
                            {row.delegationId}
                          </span>
                          <button
                            onClick={() => copyKeyToClipboard(row.delegationId as string)}
                            className="ml-auto text-[11px] px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 rounded"
                          >
                            Copy
                          </button>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="block text-xs text-zinc-400">
                          Canonical message to sign
                        </label>
                        <button
                          onClick={() => copyKeyToClipboard(row.canonicalMessage)}
                          className="text-[11px] px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 rounded"
                        >
                          Copy canonical
                        </button>
                      </div>
                      <p
                        data-testid={`pending-canonical-${row.id}`}
                        className="font-mono text-[11px] bg-zinc-950 border border-zinc-800 rounded px-3 py-2 break-all"
                      >
                        {row.canonicalMessage}
                      </p>
                    </div>

                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">
                        Signature (hex, no 0x prefix)
                      </label>
                      <textarea
                        data-testid={`pending-signature-input-${row.id}`}
                        value={sigVal}
                        onChange={(e) =>
                          setSignatureInput((m) => ({ ...m, [row.id]: e.target.value }))
                        }
                        rows={2}
                        placeholder="Paste a hex signature produced externally with your debtor or session key..."
                        disabled={isSubmitting}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs font-mono focus:outline-none focus:border-zinc-500 resize-none disabled:opacity-50"
                      />
                    </div>

                    <button
                      data-testid={`pending-submit-${row.id}`}
                      onClick={() => submitSignature(row)}
                      disabled={!sigVal.trim() || isSubmitting}
                      className="px-4 py-2 bg-blue-700 text-white rounded text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {isSubmitting ? "Submitting..." : "Submit Signature"}
                    </button>

                    {err && (
                      <p
                        data-testid={`pending-error-${row.id}`}
                        className="text-xs text-red-400"
                      >
                        {err}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Provider Tabs */}
      <div>
        <h2 className="text-xl font-semibold mb-3">Provider Tabs</h2>
        <div className="space-y-3">
          {customer.creditLines.map((line) => {
            const obl = customer.obligationStates.find((o) => o.providerId === line.providerId);
            const balance = BigInt(obl?.currentAmount ?? "0");
            const limitBig = BigInt(line.limitAmount);
            const remaining = limitBig - balance;
            const util = limitBig > BigInt(0) ? Number(balance) / Number(limitBig) : 0;
            const alertActive = util >= line.alertThreshold;
            return (
              <div key={line.id} className={`border rounded-lg p-5 ${alertActive ? "border-yellow-700" : "border-zinc-800"}`}>
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/provider/${line.providerId}`}
                        className="text-lg font-medium hover:underline"
                      >
                        {line.provider.name}
                      </Link>
                      {alertActive && (
                        <span className="text-xs px-2 py-1 rounded bg-yellow-900/50 text-yellow-400 border border-yellow-800">
                          {util >= 1.0 ? "Limit Reached" : "High Utilization"}
                        </span>
                      )}
                      {line.status === "paused" && (
                        <span className="text-xs px-2 py-1 rounded bg-yellow-900/50 text-yellow-400">
                          Paused
                        </span>
                      )}
                    </div>
                    <div className="flex gap-6 mt-2 text-sm">
                      <div>
                        <span className="text-zinc-500">Balance: </span>
                        <span className="font-mono">${formatCredits(balance)}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">Limit: </span>
                        <span className="font-mono">${formatCredits(limitBig)}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">Remaining: </span>
                        <span className={`font-mono ${remaining < BigInt(10_000_000_000) ? "text-yellow-400" : ""}`}>
                          ${formatCredits(remaining)}
                        </span>
                      </div>
                      {obl?.latestSignature && (
                        <div>
                          <Link
                            href={`/obligation/${obl.id}`}
                            className="text-blue-400 hover:underline text-xs"
                          >
                            View Credit Statement (v{obl.version})
                          </Link>
                        </div>
                      )}
                    </div>
                    {/* Mini utilization bar */}
                    <div className="mt-3 w-64">
                      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            util >= 0.9 ? "bg-red-500" : util >= 0.7 ? "bg-yellow-500" : "bg-green-500"
                          }`}
                          style={{ width: `${Math.min(util * 100, 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => settle(line.providerId, balance)}
                    disabled={balance <= BigInt(0) || settling === line.providerId}
                    className="px-4 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {settling === line.providerId ? "Settling..." : `Settle $${formatCredits(balance)}`}
                  </button>
                </div>
              </div>
            );
          })}
          {customer.creditLines.length === 0 && (
            <div className="border border-dashed border-zinc-700 rounded-lg p-8 text-center text-zinc-500">
              No credit lines yet. A provider must issue one.
            </div>
          )}
        </div>
      </div>

      {/* Agent Identities */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold">Agent Identities</h2>
          <button
            onClick={() => setShowAgentForm(!showAgentForm)}
            className="text-sm px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
          >
            {showAgentForm ? "Cancel" : "+ New Agent"}
          </button>
        </div>

        {lastCreatedApiKey && (
          <div
            data-testid="one-time-key-banner"
            className="border border-yellow-700 bg-yellow-900/20 rounded-lg p-4 mb-4"
          >
            <h3 className="font-medium text-yellow-200 mb-1">
              {lastKeyContext === "rotated"
                ? "Rotated agent API key — shown once"
                : "New agent API key — shown once"}
            </h3>
            <p className="text-sm text-zinc-300 mb-2">
              {lastKeyContext === "rotated"
                ? "The previous key has been invalidated. Save this new key now — after dismissing this banner only the last 4 characters will be shown."
                : "Save this now. After dismissing this banner the full key will not be shown again — only the last 4 characters."}
            </p>
            <p
              data-testid="one-time-key-value"
              className="font-mono text-sm bg-zinc-950 border border-zinc-800 rounded px-3 py-2 mb-3 break-all"
            >
              {lastCreatedApiKey}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => copyKeyToClipboard(lastCreatedApiKey)}
                className="px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded"
              >
                Copy
              </button>
              <button
                onClick={() => {
                  setLastCreatedApiKey(null);
                  setLastKeyContext(null);
                }}
                className="px-3 py-1 bg-yellow-700 hover:bg-yellow-600 text-white text-sm rounded"
              >
                I&apos;ve saved it — dismiss
              </button>
            </div>
          </div>
        )}

        {showAgentForm && (
          <form onSubmit={createAgent} className="border border-zinc-700 rounded-lg p-4 space-y-3 bg-zinc-900 mb-3">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Agent Label</label>
              <input
                type="text"
                value={agentLabel}
                onChange={(e) => setAgentLabel(e.target.value)}
                placeholder="e.g. incident-responder"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                autoFocus
              />
            </div>
            <p className="text-xs text-zinc-500">
              An API key will be generated. The agent signs obligations using the customer&apos;s debtor key.
            </p>
            <button
              type="submit"
              className="px-4 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 transition-colors"
            >
              Create Agent
            </button>
          </form>
        )}

        <div className="space-y-3">
          {customer.agentIdentities.map((agent) => {
            const isActing = actingOnId === agent.id;
            const isConfirmingRevoke = confirmRevokeId === agent.id;
            const isConfirmingRotate = confirmRotateId === agent.id;
            const err = actionError[agent.id];
            const inConfirm = isConfirmingRevoke || isConfirmingRotate;
            return (
              <div
                key={agent.id}
                data-testid={`agent-card-${agent.id}`}
                className="border border-zinc-800 rounded-lg p-4"
              >
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="font-medium">{agent.label}</h3>
                    <p className="text-xs text-zinc-500 mt-1 font-mono">
                      API Key: <span className="text-zinc-400">{agent.apiKeyPreview ?? "—"}</span>
                    </p>
                    <p className="text-[10px] text-zinc-600 mt-0.5">
                      Full key shown once at creation or rotation.
                    </p>
                  </div>
                  <StatusBadge status={agent.status} />
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  {!inConfirm && agent.status === "active" && (
                    <button
                      data-testid={`agent-revoke-${agent.id}`}
                      onClick={() => {
                        clearAgentError(agent.id);
                        setConfirmRotateId(null);
                        setConfirmRevokeId(agent.id);
                      }}
                      disabled={isActing}
                      className="text-sm px-2.5 py-1 text-red-400 border border-red-800/50 rounded hover:bg-red-900/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      Revoke
                    </button>
                  )}
                  {!inConfirm && agent.status === "revoked" && (
                    <button
                      data-testid={`agent-reactivate-${agent.id}`}
                      onClick={() => {
                        clearAgentError(agent.id);
                        patchAgentStatus(agent.id, "active");
                      }}
                      disabled={isActing}
                      className="text-sm px-2.5 py-1 text-green-400 border border-green-800/50 rounded hover:bg-green-900/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      Reactivate
                    </button>
                  )}
                  {!inConfirm && (
                    <button
                      data-testid={`agent-rotate-${agent.id}`}
                      onClick={() => {
                        clearAgentError(agent.id);
                        setConfirmRevokeId(null);
                        setConfirmRotateId(agent.id);
                      }}
                      disabled={isActing}
                      className="text-sm px-2.5 py-1 text-zinc-300 border border-zinc-700 rounded hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      Rotate Key
                    </button>
                  )}

                  {isConfirmingRevoke && (
                    <>
                      <span className="text-xs text-zinc-400">Revoke this agent?</span>
                      <button
                        data-testid={`agent-confirm-revoke-${agent.id}`}
                        onClick={() => patchAgentStatus(agent.id, "revoked")}
                        disabled={isActing}
                        className="text-sm px-2.5 py-1 bg-red-700 hover:bg-red-600 text-white rounded disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        {isActing ? "Revoking..." : "Confirm Revoke"}
                      </button>
                      <button
                        data-testid={`agent-cancel-revoke-${agent.id}`}
                        onClick={() => setConfirmRevokeId(null)}
                        disabled={isActing}
                        className="text-sm px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 text-white rounded disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        Cancel
                      </button>
                    </>
                  )}

                  {isConfirmingRotate && (
                    <>
                      <span className="text-xs text-zinc-400">
                        Old key stops working immediately.
                      </span>
                      <button
                        data-testid={`agent-confirm-rotate-${agent.id}`}
                        onClick={() => rotateAgentKey(agent.id)}
                        disabled={isActing}
                        className="text-sm px-2.5 py-1 bg-zinc-200 hover:bg-white text-black rounded disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        {isActing ? "Rotating..." : "Confirm Rotate"}
                      </button>
                      <button
                        data-testid={`agent-cancel-rotate-${agent.id}`}
                        onClick={() => setConfirmRotateId(null)}
                        disabled={isActing}
                        className="text-sm px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 text-white rounded disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
                {err && (
                  <p
                    data-testid={`agent-error-${agent.id}`}
                    className="text-xs text-red-400 mt-2"
                  >
                    {err}
                  </p>
                )}
              </div>
            );
          })}
          {customer.agentIdentities.length === 0 && (
            <div className="border border-dashed border-zinc-700 rounded-lg p-8 text-center text-zinc-500">
              No agent identities yet
            </div>
          )}
        </div>
      </div>

      {/* Usage History */}
      <div>
        <h2 className="text-xl font-semibold mb-3">Usage History</h2>
        <div className="border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-zinc-400">Time</th>
                <th className="text-left px-4 py-3 font-medium text-zinc-400">Agent</th>
                <th className="text-left px-4 py-3 font-medium text-zinc-400">Tool</th>
                <th className="text-right px-4 py-3 font-medium text-zinc-400">Cost</th>
                <th className="text-center px-4 py-3 font-medium text-zinc-400">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {usage.slice(0, 30).map((e) => (
                <tr key={e.id} className="hover:bg-zinc-900/50">
                  <td className="px-4 py-3 text-zinc-400 font-mono text-xs">
                    {new Date(e.timestamp).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">{e.agentIdentity.label}</td>
                  <td className="px-4 py-3">{e.tool.name}</td>
                  <td className="px-4 py-3 text-right font-mono">${formatCredits(BigInt(e.amountCharged))}</td>
                  <td className="px-4 py-3 text-center">
                    <StatusBadge status={e.outcome} />
                  </td>
                </tr>
              ))}
              {usage.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                    No usage events yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`border rounded-lg p-4 ${highlight ? "border-zinc-600 bg-zinc-900" : "border-zinc-800"}`}>
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="text-2xl font-mono mt-1">{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-green-900/50 text-green-400",
    success: "bg-green-900/50 text-green-400",
    revoked: "bg-zinc-800 text-zinc-400",
    denied: "bg-red-900/50 text-red-400",
    error: "bg-red-900/50 text-red-400",
  };
  return (
    <span className={`text-xs px-2 py-1 rounded ${colors[status] || "bg-zinc-800 text-zinc-400"}`}>
      {status}
    </span>
  );
}
