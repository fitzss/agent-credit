"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { formatCredits } from "@/lib/credits";

interface Proof {
  obligationId: string;
  debtorPubKey: string;
  creditorPubKey: string;
  currentAmount: string;
  pendingAmount: string;
  version: number;
  lastUpdatedAt: string;
  canonicalMessage: string;
  signature: string;
  verified: boolean;
  debtor: string;
  creditor: string;
  settlementStatus: string;
}

interface Update {
  id: string;
  version: number;
  previousAmount: string;
  newAmount: string;
  delta: string;
  canonicalMessage: string;
  signature: string;
  type: string;
  timestamp: string;
}

export default function CreditStatementPage() {
  const { id } = useParams<{ id: string }>();
  const [proof, setProof] = useState<Proof | null>(null);
  const [history, setHistory] = useState<Update[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/obligations/${id}/proof`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then(setProof)
      .catch(() => setError("Obligation not found"));

    fetch(`/api/obligations/${id}/history`)
      .then((r) => r.json())
      .then(setHistory);
  }, [id]);

  if (error) {
    return (
      <div>
        <Link href="/" className="text-sm text-zinc-500 hover:text-white">
          &larr; Back
        </Link>
        <p className="mt-4 text-red-400">{error}</p>
      </div>
    );
  }

  if (!proof) return <div className="text-zinc-500">Loading...</div>;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm text-zinc-500 hover:text-white transition-colors">
          &larr; Back
        </Link>
        <h1 className="text-3xl font-bold mt-2">Credit Statement</h1>
        <p className="text-zinc-400">
          {proof.debtor} &rarr; {proof.creditor}
        </p>
      </div>

      {/* Signed Balance */}
      <div className="border border-zinc-700 rounded-lg p-6 bg-zinc-900">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-zinc-500 uppercase tracking-wider">
              Current Signed Balance
            </p>
            <p className="text-4xl font-mono mt-2">${formatCredits(BigInt(proof.currentAmount))}</p>
            <p className="text-sm text-zinc-500 mt-1">
              Version {proof.version} &middot; {new Date(proof.lastUpdatedAt).toLocaleString()}
            </p>
          </div>
          <div className="text-right">
            <VerificationBadge verified={proof.verified} />
            <p className="text-xs text-zinc-500 mt-2 capitalize">{proof.settlementStatus}</p>
          </div>
        </div>
      </div>

      {/* Key Identities */}
      <div className="grid grid-cols-2 gap-4">
        <div className="border border-zinc-800 rounded-lg p-4">
          <p className="text-sm text-zinc-500">Debtor (Customer)</p>
          <p className="font-medium mt-1">{proof.debtor}</p>
          <p className="text-xs font-mono text-zinc-500 mt-2 break-all">
            {proof.debtorPubKey}
          </p>
        </div>
        <div className="border border-zinc-800 rounded-lg p-4">
          <p className="text-sm text-zinc-500">Creditor (Provider)</p>
          <p className="font-medium mt-1">{proof.creditor}</p>
          <p className="text-xs font-mono text-zinc-500 mt-2 break-all">
            {proof.creditorPubKey}
          </p>
        </div>
      </div>

      {/* Latest Signed Message */}
      <div>
        <h2 className="text-xl font-semibold mb-3">Latest Signed State</h2>
        <div className="border border-zinc-800 rounded-lg p-4 space-y-3">
          <div>
            <p className="text-xs text-zinc-500 uppercase tracking-wider">Canonical Message</p>
            <p className="font-mono text-sm mt-1 break-all bg-zinc-900 p-3 rounded">
              {proof.canonicalMessage || "None"}
            </p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 uppercase tracking-wider">Debtor Signature</p>
            <p className="font-mono text-xs mt-1 break-all bg-zinc-900 p-3 rounded text-zinc-400">
              {proof.signature || "None"}
            </p>
          </div>
          {proof.canonicalMessage && proof.signature && (
            <Link
              href={`/verify?message=${encodeURIComponent(proof.canonicalMessage)}&signature=${encodeURIComponent(proof.signature)}&publicKey=${encodeURIComponent(proof.debtorPubKey)}`}
              className="inline-block mt-2 text-sm px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
            >
              Verify in Browser &rarr;
            </Link>
          )}
        </div>
      </div>

      {/* Update History */}
      <div>
        <h2 className="text-xl font-semibold mb-3">
          Obligation History ({history.length} updates)
        </h2>
        <div className="border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-zinc-400">Version</th>
                <th className="text-left px-4 py-3 font-medium text-zinc-400">Type</th>
                <th className="text-right px-4 py-3 font-medium text-zinc-400">Delta</th>
                <th className="text-right px-4 py-3 font-medium text-zinc-400">New Balance</th>
                <th className="text-left px-4 py-3 font-medium text-zinc-400">Signature</th>
                <th className="text-left px-4 py-3 font-medium text-zinc-400">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {history.map((u) => (
                <tr key={u.id} className="hover:bg-zinc-900/50">
                  <td className="px-4 py-3 font-mono">v{u.version}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-1 rounded ${
                        u.type === "charge"
                          ? "bg-blue-900/50 text-blue-400"
                          : "bg-green-900/50 text-green-400"
                      }`}
                    >
                      {u.type}
                    </span>
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-mono ${
                      BigInt(u.delta) >= BigInt(0) ? "text-red-400" : "text-green-400"
                    }`}
                  >
                    {BigInt(u.delta) >= BigInt(0) ? "+" : ""}${formatCredits(BigInt(u.delta))}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">${formatCredits(BigInt(u.newAmount))}</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                    {u.signature.slice(0, 16)}...
                  </td>
                  <td className="px-4 py-3 text-zinc-400 text-xs">
                    {new Date(u.timestamp).toLocaleString()}
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                    No updates yet
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

function VerificationBadge({ verified }: { verified: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full ${
        verified
          ? "bg-green-900/50 text-green-400 border border-green-800"
          : "bg-red-900/50 text-red-400 border border-red-800"
      }`}
    >
      <span className={`w-2 h-2 rounded-full ${verified ? "bg-green-400" : "bg-red-400"}`} />
      {verified ? "Signature Verified" : "Signature Invalid"}
    </span>
  );
}
