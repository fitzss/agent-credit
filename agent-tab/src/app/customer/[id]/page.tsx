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

  // Self-custody signing (standalone — paste obligation id + canonical message)
  const [signObligationId, setSignObligationId] = useState("");
  const [signCanonicalMessage, setSignCanonicalMessage] = useState("");
  const [signingKey, setSigningKey] = useState("");
  const [signing, setSigning] = useState(false);
  const [signResult, setSignResult] = useState<string | null>(null);

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
      }
    }
    setAgentLabel("");
    setShowAgentForm(false);
    load();
  };

  const signPending = async () => {
    if (!signObligationId.trim() || !signCanonicalMessage.trim() || !signingKey.trim()) return;
    setSigning(true);
    setSignResult(null);

    try {
      // Sign client-side using @noble/secp256k1. The private key is used in
      // the browser only and is never sent to the server.
      const secp = await import("@noble/secp256k1");
      const msgBytes = new TextEncoder().encode(signCanonicalMessage);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBytes);
      const msgHash = new Uint8Array(hashBuffer);
      const privKeyBytes = secp.etc.hexToBytes(signingKey);
      const sig = secp.sign(msgHash, privKeyBytes);
      const sigHex = secp.etc.bytesToHex(sig);

      const res = await fetch(`/api/obligations/${signObligationId.trim()}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: sigHex }),
      });
      const data = await res.json();

      if (data.error) {
        setSignResult(`Failed: ${data.error}`);
      } else {
        setSignResult("Signed and verified by tracker");
        load();
      }
    } catch (e) {
      setSignResult(`Signing error: ${String(e)}`);
    }

    setSigning(false);
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

      {/* Sign Pending Obligation — standalone, self-custody only */}
      {customer.signingMode === "self-custody" && (
        <div className="border border-blue-800 rounded-lg p-5 bg-blue-900/20 space-y-3">
          <h2 className="text-xl font-semibold text-blue-200">Sign Pending Obligation</h2>
          <p className="text-xs text-blue-400/70">
            If you have a pending obligation update (e.g. printed by the bounded-buyer demo
            runner) paste its obligation id, canonical message, and your debtor signing key
            to sign and commit. Your private key is used only in your browser — it is never
            sent to the server.
          </p>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Obligation ID</label>
            <input
              value={signObligationId}
              onChange={(e) => setSignObligationId(e.target.value)}
              placeholder="obl-..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-zinc-500"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Canonical Message</label>
            <textarea
              value={signCanonicalMessage}
              onChange={(e) => setSignCanonicalMessage(e.target.value)}
              rows={3}
              placeholder="Paste the canonical message printed by the proxy or demo runner..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs font-mono focus:outline-none focus:border-zinc-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Signing Key (hex)</label>
            <input
              type="password"
              value={signingKey}
              onChange={(e) => setSigningKey(e.target.value)}
              placeholder="Enter your secp256k1 private key..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-zinc-500"
            />
            <p className="text-xs text-zinc-600 mt-1">
              Signing happens entirely in your browser. The key is never transmitted.
            </p>
          </div>
          <button
            onClick={signPending}
            disabled={!signObligationId.trim() || !signCanonicalMessage.trim() || !signingKey.trim() || signing}
            className="px-5 py-2.5 bg-blue-700 text-white rounded text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {signing ? "Signing..." : "Sign and Commit"}
          </button>
          {signResult && (
            <p className={`text-sm ${signResult.startsWith("Signed") ? "text-green-400" : "text-red-400"}`}>
              {signResult}
            </p>
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
          <div className="border border-yellow-700 bg-yellow-900/20 rounded-lg p-4 mb-4">
            <h3 className="font-medium text-yellow-200 mb-1">New agent API key — shown once</h3>
            <p className="text-sm text-zinc-300 mb-2">
              Save this now. After dismissing this banner the full key will not be shown
              again — only the last 4 characters.
            </p>
            <p className="font-mono text-sm bg-zinc-950 border border-zinc-800 rounded px-3 py-2 mb-3 break-all">
              {lastCreatedApiKey}
            </p>
            <button
              onClick={() => setLastCreatedApiKey(null)}
              className="px-3 py-1 bg-yellow-700 hover:bg-yellow-600 text-white text-sm rounded"
            >
              I&apos;ve saved it — dismiss
            </button>
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
          {customer.agentIdentities.map((agent) => (
            <div key={agent.id} className="border border-zinc-800 rounded-lg p-4">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="font-medium">{agent.label}</h3>
                  <p className="text-xs text-zinc-500 mt-1 font-mono">
                    API Key: <span className="text-zinc-400">{agent.apiKeyPreview ?? "—"}</span>
                  </p>
                  <p className="text-[10px] text-zinc-600 mt-0.5">
                    Full key shown once at creation.
                  </p>
                </div>
                <StatusBadge status={agent.status} />
              </div>
            </div>
          ))}
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
    denied: "bg-red-900/50 text-red-400",
    error: "bg-red-900/50 text-red-400",
  };
  return (
    <span className={`text-xs px-2 py-1 rounded ${colors[status] || "bg-zinc-800 text-zinc-400"}`}>
      {status}
    </span>
  );
}
