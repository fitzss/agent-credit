"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCredits } from "@/lib/credits";

/**
 * Pool selector — doorway to individual pool views.
 *
 * If exactly one active pool exists, auto-redirects to /pool/[id].
 * If multiple exist, shows a minimal card list.
 */

interface ReserveEntry {
  id: string;
  customerName: string;
  customerId: string;
  valueNanoErg: string;
  lifecycle: string;
  contractVersion: string;
  obligationCount: number;
  authorityMode: string;
}

export default function PoolSelector() {
  const router = useRouter();
  const [reserves, setReserves] = useState<ReserveEntry[] | null>(null);

  useEffect(() => {
    fetch("/api/pool/summary")
      .then((r) => r.json())
      .then((data) => {
        const list: ReserveEntry[] = data.reserves || [];
        if (list.length === 1) {
          router.replace(`/pool/${list[0].id}`);
        } else {
          setReserves(list);
        }
      });
  }, [router]);

  if (reserves === null) {
    return <div className="text-zinc-500">Loading pools...</div>;
  }

  if (reserves.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <Link href="/" className="text-sm text-zinc-500 hover:text-white transition-colors">
            &larr; Overview
          </Link>
          <h1 className="text-3xl font-bold mt-2">Pools</h1>
        </div>
        <div className="border border-dashed border-zinc-700 rounded-lg px-5 py-12 text-center">
          <p className="text-zinc-400">No active pools.</p>
          <p className="text-zinc-600 text-sm mt-1">
            Deploy a reserve to create a backing pool.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-zinc-500 hover:text-white transition-colors">
          &larr; Overview
        </Link>
        <h1 className="text-3xl font-bold mt-2">Pools</h1>
        <p className="text-zinc-400 mt-1">Select a backing pool to view.</p>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {reserves.map((r) => (
          <Link
            key={r.id}
            href={`/pool/${r.id}`}
            className="border border-zinc-800 rounded-lg p-5 hover:border-zinc-600 transition-colors block"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">{r.customerName}</h2>
                <span
                  className={`inline-block px-2 py-0.5 text-xs rounded-full ${
                    r.authorityMode === "delegated"
                      ? "bg-blue-900/50 text-blue-400"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {r.authorityMode === "delegated"
                    ? "Delegated Authority"
                    : "Tracker-Managed"}
                </span>
              </div>
              <span className="text-zinc-500 text-sm">&rarr;</span>
            </div>
            <div className="flex gap-6 mt-3 text-sm text-zinc-400">
              <span className="font-mono">
                {formatCredits(BigInt(r.valueNanoErg))} ERG
              </span>
              <span>
                {r.obligationCount} obligation{r.obligationCount !== 1 ? "s" : ""}
              </span>
              <span className="text-zinc-600">{r.contractVersion}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
