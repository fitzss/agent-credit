"use client";

import Link from "next/link";
import { formatCredits } from "@/lib/credits";
import { ReadinessBadge } from "./badges";
import { UtilizationBar } from "./UtilizationBar";

export interface ObligationRow {
  id: string;
  providerId: string;
  providerName: string;
  customerId: string;
  customerName: string;
  currentAmount: string;
  version: number;
  settlementStatus: string;
  debtorPubKey: string;
  creditorPubKey: string;
  latestSignature: string | null;
  creditLimit: string | null;
  alertThreshold: number | null;
  reserveId: string | null;
  settlementReadiness: string;
}

interface Props {
  obligations: ObligationRow[];
  redeemingId: string | null;
  redeemResult: { obligationId: string; success: boolean; message: string } | null;
  onRedeem: (reserveId: string, obligationId: string) => void;
  onDismissResult: () => void;
}

export function ObligationTable({
  obligations,
  redeemingId,
  redeemResult,
  onRedeem,
  onDismissResult,
}: Props) {
  return (
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
            onClick={onDismissResult}
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
              <th className="px-4 py-3 font-medium">Outstanding</th>
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
                const current = BigInt(o.currentAmount);
                const limit = o.creditLimit ? BigInt(o.creditLimit) : BigInt(0);
                const utilization =
                  limit > BigInt(0)
                    ? Number(current) / Number(limit)
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
                      {formatCredits(current)}
                    </td>
                    <td className="px-4 py-3 font-mono text-zinc-400">
                      {o.creditLimit !== null ? formatCredits(limit) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {o.creditLimit !== null && limit > BigInt(0) ? (
                        <UtilizationBar ratio={utilization} />
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
                          onClick={() => onRedeem(o.reserveId!, o.id)}
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
  );
}
