"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatCredits } from "@/lib/credits";

interface Provider {
  id: string;
  name: string;
  publicKey: string;
  status: string;
  obligationStates: { currentAmount: bigint }[];
  creditLines: { limitAmount: bigint; customerId: string }[];
}

interface Customer {
  id: string;
  name: string;
  publicKey: string;
  contactEmail: string | null;
  obligationStates: { currentAmount: bigint; providerId: string }[];
  creditLines: { limitAmount: bigint; providerId: string }[];
}

export default function Home() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [seeding, setSeeding] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Form state
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [providerName, setProviderName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");

  const load = () => {
    fetch("/api/providers").then((r) => r.json()).then(setProviders);
    fetch("/api/customers").then((r) => r.json()).then((c) => { setCustomers(c); setLoaded(true); });
  };

  useEffect(load, []);

  const seed = async () => {
    setSeeding(true);
    await fetch("/api/seed", { method: "POST" });
    load();
    setSeeding(false);
  };

  const createProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!providerName.trim()) return;
    await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: providerName }),
    });
    setProviderName("");
    setShowProviderForm(false);
    load();
  };

  const createCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerName.trim()) return;
    await fetch("/api/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: customerName, contactEmail: customerEmail || null }),
    });
    setCustomerName("");
    setCustomerEmail("");
    setShowCustomerForm(false);
    load();
  };

  const totalReceivables = providers.reduce(
    (sum, p) => sum + p.obligationStates.reduce((s, o) => s + BigInt(o.currentAmount), BigInt(0)),
    BigInt(0)
  );
  const totalPayables = customers.reduce(
    (sum, c) => sum + c.obligationStates.reduce((s, o) => s + BigInt(o.currentAmount), BigInt(0)),
    BigInt(0)
  );

  const empty = loaded && providers.length === 0 && customers.length === 0;

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agent Tab</h1>
          <p className="text-zinc-400 mt-1">Programmable credit for agent tool markets</p>
        </div>
        <button
          onClick={seed}
          disabled={seeding}
          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-sm transition-colors disabled:opacity-50"
        >
          {seeding ? "Seeding..." : "Seed Demo Data"}
        </button>
      </div>

      {empty && (
        <div className="border border-dashed border-zinc-700 rounded-lg p-12 text-center text-zinc-500">
          <p className="text-lg">No data yet. Click &quot;Seed Demo Data&quot; or create a provider below.</p>
        </div>
      )}

      {/* Summary cards */}
      {(providers.length > 0 || customers.length > 0) && (
        <div className="grid grid-cols-3 gap-4">
          <Card label="Providers" value={providers.length.toString()} />
          <Card label="Total Receivables" value={`$${formatCredits(totalReceivables)}`} />
          <Card label="Total Payables" value={`$${formatCredits(totalPayables)}`} />
        </div>
      )}

      {/* Providers */}
      <Section
        title="Providers"
        action={
          <button
            onClick={() => setShowProviderForm(!showProviderForm)}
            className="text-sm px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
          >
            {showProviderForm ? "Cancel" : "+ New Provider"}
          </button>
        }
      >
        {showProviderForm && (
          <form onSubmit={createProvider} className="border border-zinc-700 rounded-lg p-4 space-y-3 bg-zinc-900">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Provider Name</label>
              <input
                type="text"
                value={providerName}
                onChange={(e) => setProviderName(e.target.value)}
                placeholder="e.g. ToolSmith AI"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                autoFocus
              />
            </div>
            <p className="text-xs text-zinc-500">A secp256k1 keypair will be generated automatically (creditor identity).</p>
            <button
              type="submit"
              className="px-4 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 transition-colors"
            >
              Create Provider
            </button>
          </form>
        )}
        {providers.map((p) => {
          const receivables = p.obligationStates.reduce((s, o) => s + BigInt(o.currentAmount), BigInt(0));
          return (
            <Link
              key={p.id}
              href={`/provider/${p.id}`}
              className="block border border-zinc-800 rounded-lg p-4 hover:border-zinc-600 transition-colors"
            >
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-medium">{p.name}</h3>
                  <p className="text-xs text-zinc-500 mt-1 font-mono">
                    {p.publicKey.slice(0, 16)}...
                  </p>
                  <p className="text-sm text-zinc-500 mt-1">
                    {p.creditLines.length} credit line{p.creditLines.length !== 1 ? "s" : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-mono">${formatCredits(receivables)}</p>
                  <p className="text-xs text-zinc-500">receivables</p>
                </div>
              </div>
            </Link>
          );
        })}
      </Section>

      {/* Customers */}
      <Section
        title="Customers"
        action={
          <button
            onClick={() => setShowCustomerForm(!showCustomerForm)}
            className="text-sm px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
          >
            {showCustomerForm ? "Cancel" : "+ New Customer"}
          </button>
        }
      >
        {showCustomerForm && (
          <form onSubmit={createCustomer} className="border border-zinc-700 rounded-lg p-4 space-y-3 bg-zinc-900">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Customer Name</label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="e.g. Acme Startup"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Contact Email (optional)</label>
              <input
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                placeholder="team@company.dev"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
              />
            </div>
            <p className="text-xs text-zinc-500">A secp256k1 keypair will be generated automatically (debtor identity).</p>
            <button
              type="submit"
              className="px-4 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 transition-colors"
            >
              Create Customer
            </button>
          </form>
        )}
        {customers.map((c) => {
          const owed = c.obligationStates.reduce((s, o) => s + BigInt(o.currentAmount), BigInt(0));
          const totalLimit = c.creditLines.reduce((s, l) => s + BigInt(l.limitAmount), BigInt(0));
          return (
            <Link
              key={c.id}
              href={`/customer/${c.id}`}
              className="block border border-zinc-800 rounded-lg p-4 hover:border-zinc-600 transition-colors"
            >
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-medium">{c.name}</h3>
                  <p className="text-xs text-zinc-500 mt-1 font-mono">
                    {c.publicKey.slice(0, 16)}...
                  </p>
                  <p className="text-sm text-zinc-500 mt-1">{c.contactEmail || "No email"}</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-mono">
                    ${formatCredits(owed)} <span className="text-zinc-500 text-sm">/ ${formatCredits(totalLimit)}</span>
                  </p>
                  <p className="text-xs text-zinc-500">balance / limit</p>
                </div>
              </div>
            </Link>
          );
        })}
      </Section>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-zinc-800 rounded-lg p-4">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="text-2xl font-mono mt-1">{value}</p>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-semibold">{title}</h2>
        {action}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
