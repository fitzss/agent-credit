import { formatCredits } from "@/lib/credits";

export interface TrackerEntry {
  id: string;
  debtorPubKey: string;
  creditorPubKey: string;
  totalDebtNanoErg: string;
  creditorName: string;
}

export interface TrackerBoxData {
  id: string;
  trackerNftId: string;
  boxId: string;
  trackerPubKeyHex: string;
  treeDigestHex: string;
  isCurrent: boolean;
  entries: TrackerEntry[];
}

interface Props {
  tracker: TrackerBoxData[];
}

export function TrackerStateCard({ tracker }: Props) {
  return (
    <div>
      <h2 className="text-xl font-semibold mb-3">Tracker State</h2>
      {tracker.length === 0 ? (
        <div className="border border-zinc-800 rounded-lg px-5 py-6 text-center">
          <p className="text-zinc-400 text-sm">
            No tracker deployed for this pool.
          </p>
          <p className="text-zinc-600 text-xs mt-1">
            A tracker is deployed automatically on first redemption.
          </p>
        </div>
      ) : (
        tracker.map((tb) => (
          <div
            key={tb.id}
            className="border border-zinc-800 rounded-lg p-5 space-y-4"
          >
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-zinc-500">Tracker NFT</p>
                <p className="font-mono text-zinc-400">
                  {tb.trackerNftId.substring(0, 16)}...
                </p>
              </div>
              <div>
                <p className="text-zinc-500">Current Box</p>
                <p className="font-mono text-zinc-400">
                  {tb.boxId.substring(0, 16)}...
                </p>
              </div>
              <div>
                <p className="text-zinc-500">Tree Digest</p>
                <p className="font-mono text-zinc-400">
                  {tb.treeDigestHex.substring(0, 16)}...
                </p>
              </div>
            </div>

            {tb.entries.length > 0 ? (
              <div className="border border-zinc-800/50 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 text-left text-zinc-500">
                      <th className="px-4 py-2 font-medium">Creditor</th>
                      <th className="px-4 py-2 font-medium">Committed Debt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tb.entries.map((e) => (
                      <tr key={e.id} className="border-b border-zinc-800/30">
                        <td className="px-4 py-2 text-zinc-300">
                          {e.creditorName}
                        </td>
                        <td className="px-4 py-2 font-mono">
                          {formatCredits(BigInt(e.totalDebtNanoErg))} ERG
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-zinc-600 text-sm">
                No entries in tracker tree.
              </p>
            )}
          </div>
        ))
      )}
    </div>
  );
}
