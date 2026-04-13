import { formatCredits } from "@/lib/credits";
import { MethodBadge } from "./badges";

export interface SettlementData {
  id: string;
  obligationStateId: string;
  providerName: string;
  amount: string;
  method: string;
  status: string;
  redemptionTxId: string | null;
  timestamp: string;
}

interface Props {
  settlements: SettlementData[];
}

export function SettlementHistory({ settlements }: Props) {
  return (
    <div>
      <h2 className="text-xl font-semibold mb-3">Settlement History</h2>
      {settlements.length === 0 ? (
        <div className="border border-zinc-800 rounded-lg px-5 py-6 text-center">
          <p className="text-zinc-400 text-sm">
            No settlements recorded for this pool.
          </p>
        </div>
      ) : (
        <div className="border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-500">
                <th className="px-4 py-3 font-medium">Provider</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Method</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Tx</th>
                <th className="px-4 py-3 font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {settlements.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-zinc-800/50 hover:bg-zinc-900/50 transition-colors"
                >
                  <td className="px-4 py-3 text-zinc-300">
                    {s.providerName}
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {formatCredits(BigInt(s.amount))}
                  </td>
                  <td className="px-4 py-3">
                    <MethodBadge method={s.method} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-green-900/50 text-green-400">
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-zinc-400">
                    {s.redemptionTxId
                      ? s.redemptionTxId.substring(0, 12) + "..."
                      : "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-zinc-400">
                    {new Date(s.timestamp).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
