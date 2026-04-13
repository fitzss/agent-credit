"use client";

import { formatCredits } from "@/lib/credits";
import { ComplianceBadge } from "./badges";
import { TimeRemaining } from "./TimeRemaining";
import { UtilizationBar } from "./UtilizationBar";

export interface DelegationRow {
  id: string;
  customerId: string;
  customerName: string;
  agentIdentityId: string | null;
  agentLabel: string | null;
  sessionPubKey: string;
  scopeProviders: string;
  scopeTools: string;
  spendCap: string;
  spentSoFar: string;
  utilization: number;
  expiresAt: string;
  timeRemainingMs: number;
  status: string;
  complianceState: string;
}

interface Props {
  delegations: DelegationRow[];
  revokingId: string | null;
  confirmRevokeId: string | null;
  onRequestRevoke: (id: string) => void;
  onConfirmRevoke: (id: string) => void;
  onCancelRevoke: () => void;
}

export function DelegationTable({
  delegations,
  revokingId,
  confirmRevokeId,
  onRequestRevoke,
  onConfirmRevoke,
  onCancelRevoke,
}: Props) {
  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-zinc-500">
            <th className="px-4 py-3 font-medium">Agent</th>
            <th className="px-4 py-3 font-medium">Session Key</th>
            <th className="px-4 py-3 font-medium">Scope</th>
            <th className="px-4 py-3 font-medium">Spend Cap</th>
            <th className="px-4 py-3 font-medium">Spent</th>
            <th className="px-4 py-3 font-medium">Utilization</th>
            <th className="px-4 py-3 font-medium">Expires</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {delegations.map((d) => {
            const canRevoke = [
              "active",
              "approaching-cap",
              "approaching-expiry",
            ].includes(d.complianceState);
            return (
              <tr
                key={d.id}
                className="border-b border-zinc-800/50 hover:bg-zinc-900/50 transition-colors"
              >
                <td className="px-4 py-3">
                  {d.agentLabel ? (
                    <span className="text-zinc-300">{d.agentLabel}</span>
                  ) : (
                    <span className="text-zinc-600 italic">
                      Unbound (legacy)
                    </span>
                  )}
                </td>
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
                <td className="px-4 py-3 font-mono">
                  ${formatCredits(BigInt(d.spendCap))}
                </td>
                <td className="px-4 py-3 font-mono">
                  ${formatCredits(BigInt(d.spentSoFar))}
                </td>
                <td className="px-4 py-3">
                  <UtilizationBar ratio={d.utilization} />
                </td>
                <td className="px-4 py-3 text-zinc-400">
                  <TimeRemaining ms={d.timeRemainingMs} />
                </td>
                <td className="px-4 py-3">
                  <ComplianceBadge state={d.complianceState} />
                </td>
                <td className="px-4 py-3">
                  {canRevoke && confirmRevokeId !== d.id && (
                    <button
                      onClick={() => onRequestRevoke(d.id)}
                      disabled={revokingId === d.id}
                      className="text-sm px-2 py-0.5 text-red-400 border border-red-800/50 rounded hover:bg-red-900/30 transition-colors disabled:opacity-30"
                    >
                      Revoke
                    </button>
                  )}
                  {confirmRevokeId === d.id && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onConfirmRevoke(d.id)}
                        disabled={revokingId === d.id}
                        className="text-xs px-2 py-0.5 bg-red-900/50 text-red-400 border border-red-800 rounded hover:bg-red-900 transition-colors disabled:opacity-30"
                      >
                        {revokingId === d.id ? "..." : "Confirm"}
                      </button>
                      <button
                        onClick={onCancelRevoke}
                        className="text-xs px-2 py-0.5 text-zinc-500 hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
