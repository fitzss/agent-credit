"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { formatCredits } from "@/lib/credits";

interface Tool {
  id: string;
  name: string;
  description: string;
  costPerCall: string;
  status: string;
}

interface CreditLine {
  id: string;
  customerId: string;
  limitAmount: string;
  alertThreshold: number;
  status: string;
  customer: { id: string; name: string };
}

interface Obligation {
  id: string;
  customerId: string;
  currentAmount: string;
  version: number;
  settlementStatus: string;
  latestSignature: string | null;
  lastUpdatedAt: string;
}

interface UsageEvent {
  id: string;
  amountCharged: string;
  timestamp: string;
  outcome: string;
  tool: { name: string };
  agentIdentity: { label: string };
}

interface Provider {
  id: string;
  name: string;
  publicKey: string;
  status: string;
  tools: Tool[];
  creditLines: CreditLine[];
  obligationStates: Obligation[];
}

interface Customer {
  id: string;
  name: string;
}

export default function ProviderDashboard() {
  const { id } = useParams<{ id: string }>();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [usage, setUsage] = useState<UsageEvent[]>([]);
  const [allCustomers, setAllCustomers] = useState<Customer[]>([]);

  // Credit line form
  const [showCreditForm, setShowCreditForm] = useState(false);
  const [creditCustomerId, setCreditCustomerId] = useState("");
  const [creditLimit, setCreditLimit] = useState("50");

  // Tool form
  const [showToolForm, setShowToolForm] = useState(false);
  const [toolName, setToolName] = useState("");
  const [toolEndpoint, setToolEndpoint] = useState("");
  const [toolCost, setToolCost] = useState("0.10");
  const [toolDesc, setToolDesc] = useState("");

  const load = useCallback(() => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then((all: Provider[]) => setProvider(all.find((p) => p.id === id) || null));
    fetch(`/api/usage?providerId=${id}`)
      .then((r) => r.json())
      .then(setUsage);
    fetch("/api/customers")
      .then((r) => r.json())
      .then(setAllCustomers);
  }, [id]);

  useEffect(load, [load]);

  const createCreditLine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!creditCustomerId || !creditLimit) return;
    await fetch("/api/credit-lines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: id,
        customerId: creditCustomerId,
        limitAmount: creditLimit,
      }),
    });
    setCreditCustomerId("");
    setCreditLimit("50");
    setShowCreditForm(false);
    load();
  };

  const createTool = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!toolName || !toolEndpoint) return;
    await fetch("/api/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: id,
        name: toolName,
        description: toolDesc,
        endpoint: toolEndpoint,
        costPerCall: toolCost,
      }),
    });
    setToolName("");
    setToolEndpoint("");
    setToolCost("0.10");
    setToolDesc("");
    setShowToolForm(false);
    load();
  };

  const toggleCreditLine = async (lineId: string, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "paused" : "active";
    await fetch("/api/credit-lines", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: lineId, status: newStatus }),
    });
    load();
  };

  if (!provider) return <div className="text-zinc-500">Loading...</div>;

  const totalReceivables = provider.obligationStates.reduce((s, o) => s + BigInt(o.currentAmount), BigInt(0));
  const totalExposure = provider.creditLines.reduce((s, l) => s + BigInt(l.limitAmount), BigInt(0));

  // Customers not yet given a credit line
  const existingCustomerIds = new Set(provider.creditLines.map((l) => l.customerId));
  const availableCustomers = allCustomers.filter((c) => !existingCustomerIds.has(c.id));

  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm text-zinc-500 hover:text-white transition-colors">
          &larr; Back
        </Link>
        <h1 className="text-3xl font-bold mt-2">{provider.name}</h1>
        <p className="text-xs font-mono text-zinc-500 mt-1">{provider.publicKey}</p>
        <p className="text-zinc-400 mt-1">Provider Dashboard</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Total Receivables" value={`$${formatCredits(totalReceivables)}`} />
        <StatCard label="Total Exposure" value={`$${formatCredits(totalExposure)}`} />
        <StatCard label="Active Lines" value={provider.creditLines.filter((l) => l.status === "active").length.toString()} />
        <StatCard label="Tools" value={provider.tools.length.toString()} />
      </div>

      {/* Customer Lines */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold">Customer Credit Lines</h2>
          {availableCustomers.length > 0 && (
            <button
              onClick={() => setShowCreditForm(!showCreditForm)}
              className="text-sm px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
            >
              {showCreditForm ? "Cancel" : "+ Issue Credit Line"}
            </button>
          )}
        </div>

        {showCreditForm && (
          <form onSubmit={createCreditLine} className="border border-zinc-700 rounded-lg p-4 space-y-3 bg-zinc-900 mb-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Customer</label>
                <select
                  value={creditCustomerId}
                  onChange={(e) => setCreditCustomerId(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                >
                  <option value="">Select customer...</option>
                  {availableCustomers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Credit Limit ($)</label>
                <input
                  type="number"
                  step="0.01"
                  value={creditLimit}
                  onChange={(e) => setCreditLimit(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                />
              </div>
            </div>
            <button
              type="submit"
              className="px-4 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 transition-colors"
            >
              Issue Credit Line
            </button>
          </form>
        )}

        <div className="border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-zinc-400">Customer</th>
                <th className="text-right px-4 py-3 font-medium text-zinc-400">Limit</th>
                <th className="text-right px-4 py-3 font-medium text-zinc-400">Balance</th>
                <th className="text-right px-4 py-3 font-medium text-zinc-400">Utilization</th>
                <th className="text-center px-4 py-3 font-medium text-zinc-400">Signed</th>
                <th className="text-center px-4 py-3 font-medium text-zinc-400">Status</th>
                <th className="text-center px-4 py-3 font-medium text-zinc-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {provider.creditLines.map((line) => {
                const obl = provider.obligationStates.find((o) => o.customerId === line.customerId);
                const balance = BigInt(obl?.currentAmount ?? "0");
                const limitBig = BigInt(line.limitAmount);
                const util = limitBig > BigInt(0) ? Number(balance) / Number(limitBig) : 0;
                const utilColor = util >= 0.9 ? "text-red-400" : util >= 0.7 ? "text-yellow-400" : "text-green-400";
                return (
                  <tr key={line.id} className="hover:bg-zinc-900/50">
                    <td className="px-4 py-3">
                      <Link href={`/customer/${line.customerId}`} className="hover:underline">
                        {line.customer.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">${formatCredits(limitBig)}</td>
                    <td className="px-4 py-3 text-right font-mono">${formatCredits(balance)}</td>
                    <td className={`px-4 py-3 text-right font-mono ${utilColor}`}>
                      {(util * 100).toFixed(0)}%
                    </td>
                    <td className="px-4 py-3 text-center">
                      {obl?.latestSignature ? (
                        <Link
                          href={`/obligation/${obl.id}`}
                          className="text-xs text-blue-400 hover:underline"
                        >
                          v{obl.version}
                        </Link>
                      ) : (
                        <span className="text-xs text-zinc-600">--</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge status={line.status} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => toggleCreditLine(line.id, line.status)}
                        className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors"
                      >
                        {line.status === "active" ? "Pause" : "Resume"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {provider.creditLines.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                    No credit lines yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Tools */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold">Tools</h2>
          <button
            onClick={() => setShowToolForm(!showToolForm)}
            className="text-sm px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
          >
            {showToolForm ? "Cancel" : "+ Add Tool"}
          </button>
        </div>

        {showToolForm && (
          <form onSubmit={createTool} className="border border-zinc-700 rounded-lg p-4 space-y-3 bg-zinc-900 mb-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Tool Name</label>
                <input
                  type="text"
                  value={toolName}
                  onChange={(e) => setToolName(e.target.value)}
                  placeholder="e.g. Text Analysis"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Cost per Call ($)</label>
                <input
                  type="number"
                  step="0.01"
                  value={toolCost}
                  onChange={(e) => setToolCost(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Endpoint URL</label>
              <input
                type="text"
                value={toolEndpoint}
                onChange={(e) => setToolEndpoint(e.target.value)}
                placeholder="e.g. /api/demo-tool/analyze"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Description</label>
              <input
                type="text"
                value={toolDesc}
                onChange={(e) => setToolDesc(e.target.value)}
                placeholder="What does this tool do?"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 transition-colors"
            >
              Add Tool
            </button>
          </form>
        )}

        <div className="grid grid-cols-2 gap-3">
          {provider.tools.map((tool) => (
            <div key={tool.id} className="border border-zinc-800 rounded-lg p-4">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-medium">{tool.name}</h3>
                  <p className="text-sm text-zinc-500 mt-1">{tool.description}</p>
                  <p className="text-xs text-zinc-600 font-mono mt-2">{tool.id}</p>
                </div>
                <span className="font-mono text-sm bg-zinc-800 px-2 py-1 rounded">
                  ${formatCredits(BigInt(tool.costPerCall))}/call
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Usage */}
      <div>
        <h2 className="text-xl font-semibold mb-3">Recent Usage</h2>
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
              {usage.slice(0, 20).map((e) => (
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

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-zinc-800 rounded-lg p-4">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="text-2xl font-mono mt-1">{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-green-900/50 text-green-400",
    success: "bg-green-900/50 text-green-400",
    paused: "bg-yellow-900/50 text-yellow-400",
    denied: "bg-red-900/50 text-red-400",
    error: "bg-red-900/50 text-red-400",
    current: "bg-blue-900/50 text-blue-400",
    settled: "bg-zinc-800 text-zinc-400",
  };
  return (
    <span className={`text-xs px-2 py-1 rounded ${colors[status] || "bg-zinc-800 text-zinc-400"}`}>
      {status}
    </span>
  );
}
