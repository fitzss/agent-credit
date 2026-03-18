"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface AgentIdentity {
  id: string;
  label: string;
  apiKey: string;
  allowedToolIds: string;
  status: string;
}

interface CreditLine {
  id: string;
  providerId: string;
  limitAmount: number;
  alertThreshold: number;
  status: string;
  provider: { id: string; name: string };
}

interface Obligation {
  id: string;
  providerId: string;
  currentAmount: number;
  version: number;
  settlementStatus: string;
  latestSignature: string | null;
  lastUpdatedAt: string;
}

interface UsageEvent {
  id: string;
  providerId: string;
  amountCharged: number;
  timestamp: string;
  outcome: string;
  tool: { name: string };
  agentIdentity: { label: string };
}

interface ToolInfo {
  id: string;
  name: string;
  description: string;
  costPerCall: number;
  status: string;
  providerId: string;
  provider: { name: string };
}

interface ProxyResult {
  toolResponse: Record<string, unknown>;
  toolStatus: number;
  tab: {
    balance: number;
    limit: number;
    remaining: number;
    utilization: number;
    version: number;
    signature: string | null;
    alert: string | null;
    charged?: boolean;
    pendingSignature?: boolean;
    canonicalMessage?: string;
    obligationId?: string;
  };
  error?: string;
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

  // Try It panel
  const [tryAgent, setTryAgent] = useState("");
  const [tryTool, setTryTool] = useState("");
  const [tryInput, setTryInput] = useState("");
  const [tryRunning, setTryRunning] = useState(false);
  const [tryResult, setTryResult] = useState<ProxyResult | null>(null);
  const [tryError, setTryError] = useState<string | null>(null);

  // Self-custody signing
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

  const settle = async (providerId: string, amount: number) => {
    setSettling(providerId);
    await fetch("/api/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, customerId: id, amount, method: "manual" }),
    });
    load();
    setSettling(null);
  };

  const createAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentLabel.trim()) return;
    await fetch("/api/agent-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: id, label: agentLabel }),
    });
    setAgentLabel("");
    setShowAgentForm(false);
    load();
  };

  const runOnCredit = async () => {
    if (!tryAgent || !tryTool || !tryInput.trim()) return;
    setTryRunning(true);
    setTryResult(null);
    setTryError(null);

    const agent = customer?.agentIdentities.find((a) => a.id === tryAgent);
    if (!agent) { setTryError("Agent not found"); setTryRunning(false); return; }

    const selectedTool = tools.find((t) => t.id === tryTool);
    const isCompletion = selectedTool?.name === "LLM Completion";
    const body = isCompletion
      ? { prompt: tryInput }
      : { text: tryInput };

    try {
      const res = await fetch("/api/proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agent-api-key": agent.apiKey,
          "x-tool-id": tryTool,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error && !data.tab) {
        setTryError(data.error);
      } else {
        setTryResult(data);
      }
    } catch {
      setTryError("Request failed");
    }

    setTryRunning(false);
    setSignResult(null);
    load();
  };

  const signPending = async () => {
    if (!tryResult?.tab.pendingSignature || !tryResult.tab.canonicalMessage || !signingKey) return;
    setSigning(true);
    setSignResult(null);

    try {
      // Sign client-side using @noble/secp256k1
      const secp = await import("@noble/secp256k1");
      const msgBytes = new TextEncoder().encode(tryResult.tab.canonicalMessage);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBytes);
      const msgHash = new Uint8Array(hashBuffer);
      const privKeyBytes = secp.etc.hexToBytes(signingKey);
      const sig = secp.sign(msgHash, privKeyBytes);
      const sigHex = secp.etc.bytesToHex(sig);

      // Send to tracker for verification and commitment
      const res = await fetch(`/api/obligations/${tryResult.tab.obligationId}/sign`, {
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

  const totalOwed = customer.obligationStates.reduce((s, o) => s + o.currentAmount, 0);
  const totalLimit = customer.creditLines.reduce((s, l) => s + l.limitAmount, 0);
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
        <StatCard label="Current Balance" value={`$${totalOwed.toFixed(2)}`} highlight />
        <StatCard label="Total Limit" value={`$${totalLimit.toFixed(2)}`} />
        <StatCard label="Remaining" value={`$${totalRemaining.toFixed(2)}`} />
        <StatCard label="Agents" value={customer.agentIdentities.length.toString()} />
      </div>

      {/* Utilization Bar */}
      {totalLimit > 0 && (
        <div>
          <div className="flex justify-between text-sm text-zinc-400 mb-1">
            <span>Credit Utilization</span>
            <span>{((totalOwed / totalLimit) * 100).toFixed(0)}%</span>
          </div>
          <div className="h-3 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                totalOwed / totalLimit >= 0.9
                  ? "bg-red-500"
                  : totalOwed / totalLimit >= 0.7
                    ? "bg-yellow-500"
                    : "bg-green-500"
              }`}
              style={{ width: `${Math.min((totalOwed / totalLimit) * 100, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Try It Panel */}
      {customer.agentIdentities.length > 0 && tools.length > 0 && (
        <div className="border border-zinc-700 rounded-lg p-5 bg-zinc-900/50">
          <h2 className="text-xl font-semibold mb-4">Try It — Run a Tool on Credit</h2>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Agent</label>
              <select
                value={tryAgent}
                onChange={(e) => setTryAgent(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
              >
                <option value="">Select agent...</option>
                {customer.agentIdentities.filter((a) => a.status === "active").map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Tool</label>
              <select
                value={tryTool}
                onChange={(e) => setTryTool(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
              >
                <option value="">Select tool...</option>
                {tools.filter((t) => {
                  const providerIds = customer.creditLines.map((l) => l.providerId);
                  return providerIds.includes(t.providerId) && t.status === "active";
                }).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.provider.name}) — ${t.costPerCall.toFixed(2)}/call
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mb-3">
            <label className="block text-sm text-zinc-400 mb-1">Input</label>
            <textarea
              value={tryInput}
              onChange={(e) => setTryInput(e.target.value)}
              rows={2}
              placeholder={tools.find((t) => t.id === tryTool)?.name === "LLM Completion"
                ? "Enter a prompt for the LLM..."
                : "Enter text to analyze..."}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-zinc-500 resize-none"
            />
          </div>
          <button
            onClick={runOnCredit}
            disabled={!tryAgent || !tryTool || !tryInput.trim() || tryRunning}
            className="px-5 py-2.5 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {tryRunning ? "Running..." : "Run on Credit"}
          </button>

          {/* Result */}
          {tryError && (
            <div className="mt-4 border border-red-800 rounded-lg p-4 bg-red-900/20">
              <p className="text-sm text-red-400">{tryError}</p>
            </div>
          )}
          {tryResult && (
            <div className="mt-4 space-y-3">
              {/* Success vs failure banner */}
              {tryResult.tab.charged === false ? (
                <div className="border border-yellow-800 rounded-lg p-4 bg-yellow-900/20">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-yellow-400" />
                    <span className="text-sm font-medium text-yellow-400">Tool failed — not charged</span>
                  </div>
                  <p className="text-xs text-yellow-400/70 mt-1">
                    The upstream tool returned an error (status {tryResult.toolStatus}).
                    No debt was created and the obligation is unchanged.
                  </p>
                </div>
              ) : (
                <div className="border border-green-800 rounded-lg p-4 bg-green-900/20">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-400" />
                    <span className="text-sm font-medium text-green-400">
                      Service delivered — charged ${(tools.find((t) => t.id === tryTool)?.costPerCall ?? 0).toFixed(2)}
                    </span>
                  </div>
                  <p className="text-xs text-green-400/70 mt-1">
                    Obligation updated to v{tryResult.tab.version}, signed by debtor.
                  </p>
                </div>
              )}

              {/* Tool response */}
              <div className="border border-zinc-700 rounded-lg p-4">
                <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">
                  {tryResult.tab.charged === false ? "Error Detail" : "Tool Response"}
                </p>
                <pre className="text-sm font-mono whitespace-pre-wrap break-all text-zinc-300 bg-zinc-900 p-3 rounded max-h-48 overflow-auto">
                  {typeof tryResult.toolResponse === "object"
                    ? JSON.stringify(tryResult.toolResponse, null, 2)
                    : String(tryResult.toolResponse)}
                </pre>
              </div>

              {/* Tab state */}
              <div className="grid grid-cols-4 gap-3">
                <div className={`border rounded p-3 ${tryResult.tab.charged === false ? "border-zinc-800" : "border-green-900"}`}>
                  <p className="text-xs text-zinc-500">Charged</p>
                  <p className={`font-mono text-lg mt-1 ${tryResult.tab.charged === false ? "text-zinc-500" : "text-green-400"}`}>
                    {tryResult.tab.charged === false ? "$0.00" : `+$${(tools.find((t) => t.id === tryTool)?.costPerCall ?? 0).toFixed(2)}`}
                  </p>
                </div>
                <div className="border border-zinc-700 rounded p-3">
                  <p className="text-xs text-zinc-500">Balance</p>
                  <p className="font-mono text-lg mt-1">${tryResult.tab.balance.toFixed(2)}</p>
                </div>
                <div className="border border-zinc-700 rounded p-3">
                  <p className="text-xs text-zinc-500">Remaining</p>
                  <p className="font-mono text-lg mt-1">${tryResult.tab.remaining.toFixed(2)}</p>
                </div>
                <div className="border border-zinc-700 rounded p-3">
                  <p className="text-xs text-zinc-500">Version</p>
                  <p className="font-mono text-lg mt-1">v{tryResult.tab.version}</p>
                </div>
              </div>
              {tryResult.tab.signature && tryResult.tab.charged !== false && (
                <p className="text-xs text-zinc-500">
                  Signed: <span className="font-mono">{tryResult.tab.signature.slice(0, 24)}...</span>
                </p>
              )}

              {/* Self-custody signing panel */}
              {tryResult.tab.pendingSignature && (
                <div className="border border-blue-800 rounded-lg p-4 bg-blue-900/20 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-400" />
                    <span className="text-sm font-medium text-blue-400">
                      Pending your signature
                    </span>
                  </div>
                  <p className="text-xs text-blue-400/70">
                    This obligation update requires your signature. The tracker has recorded the
                    charge but the obligation state will not be finalized until you sign.
                    Your private key is used only in your browser — it is never sent to the server.
                  </p>
                  <div>
                    <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Message to Sign</p>
                    <p className="font-mono text-xs break-all bg-zinc-900 p-2 rounded text-zinc-400">
                      {tryResult.tab.canonicalMessage}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm text-zinc-400 mb-1">Your Private Key (hex)</label>
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
                    disabled={!signingKey || signing}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium transition-colors disabled:opacity-30"
                  >
                    {signing ? "Signing..." : "Sign Obligation"}
                  </button>
                  {signResult && (
                    <p className={`text-sm ${signResult.startsWith("Signed") ? "text-green-400" : "text-red-400"}`}>
                      {signResult}
                    </p>
                  )}
                </div>
              )}
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
            const balance = obl?.currentAmount ?? 0;
            const remaining = line.limitAmount - balance;
            const util = line.limitAmount > 0 ? balance / line.limitAmount : 0;
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
                        <span className="font-mono">${balance.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">Limit: </span>
                        <span className="font-mono">${line.limitAmount.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">Remaining: </span>
                        <span className={`font-mono ${remaining < 10 ? "text-yellow-400" : ""}`}>
                          ${remaining.toFixed(2)}
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
                    disabled={balance <= 0 || settling === line.providerId}
                    className="px-4 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {settling === line.providerId ? "Settling..." : `Settle $${balance.toFixed(2)}`}
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
                    API Key: {agent.apiKey}
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
                  <td className="px-4 py-3 text-right font-mono">${e.amountCharged.toFixed(2)}</td>
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
