import { formatCredits } from "@/lib/credits";

export interface ActivityEvent {
  id: string;
  agentIdentityId: string;
  agentLabel: string | null;
  toolId: string;
  toolName: string | null;
  providerId: string;
  providerName: string | null;
  amountCharged: string;
  outcome: string;
  timestamp: string;
}

interface Props {
  events: ActivityEvent[];
}

const outcomeStyles: Record<string, string> = {
  success: "bg-green-900/50 text-green-400",
  denied: "bg-red-900/50 text-red-400",
  error: "bg-yellow-900/50 text-yellow-400",
};

const outcomeLabels: Record<string, string> = {
  success: "Work Receipt",
  denied: "Denied",
  error: "Upstream Error",
};

function OutcomeBadge({ outcome }: { outcome: string }) {
  const tooltip =
    outcome === "success"
      ? "Signed work receipt — obligation advanced."
      : outcome === "denied"
        ? "Denied — no work receipt, no state moved."
        : outcome === "error"
          ? "Upstream tool error — no work receipt, no state moved."
          : undefined;
  return (
    <span
      title={tooltip}
      className={`inline-block px-2 py-0.5 text-xs rounded-full ${outcomeStyles[outcome] || "bg-zinc-800 text-zinc-400"}`}
    >
      {outcomeLabels[outcome] || outcome}
    </span>
  );
}

export function ActivityFeed({ events }: Props) {
  return (
    <div>
      <h2 className="text-xl font-semibold">Recent Agent Activity</h2>
      <p className="text-xs text-zinc-500 mb-3 mt-1">
        Each charged call mints a Work Receipt: a signed obligation update.
      </p>
      {events.length === 0 ? (
        <div className="border border-zinc-800 rounded-lg px-5 py-6 text-center">
          <p className="text-zinc-400 text-sm">
            No agent activity yet for this pool.
          </p>
        </div>
      ) : (
        <div className="border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-500">
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Agent</th>
                <th className="px-4 py-3 font-medium">Tool</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={e.id}
                  className="border-b border-zinc-800/50 hover:bg-zinc-900/50 transition-colors"
                >
                  <td className="px-4 py-3 text-zinc-400">
                    {new Date(e.timestamp).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-zinc-300">
                    {e.agentLabel ?? e.agentIdentityId.substring(0, 12) + "…"}
                  </td>
                  <td className="px-4 py-3 text-zinc-300">
                    <div>{e.toolName ?? "—"}</div>
                    {e.providerName && (
                      <div className="text-xs text-zinc-500 mt-0.5">
                        {e.providerName}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {e.outcome === "success" ? (
                      formatCredits(BigInt(e.amountCharged))
                    ) : e.outcome === "denied" ? (
                      <span className="text-zinc-500">no charge</span>
                    ) : e.outcome === "error" ? (
                      <span className="text-zinc-500">
                        no charge (upstream error)
                      </span>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <OutcomeBadge outcome={e.outcome} />
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
