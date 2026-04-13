import Link from "next/link";
import { formatCredits } from "@/lib/credits";
import { LifecycleBadge, VersionBadge } from "./badges";

export interface ReserveData {
  id: string;
  reserveTokenId: string;
  trackerNftId: string;
  valueNanoErg: string;
  lifecycle: string;
  contractVersion: string;
  avlTreeDigest: string | null;
  updatedAt: string;
  customer: {
    id: string;
    name: string;
    publicKey: string;
    signingMode: string;
  };
}

interface Props {
  reserve: ReserveData;
  refreshing: boolean;
  onRefresh: (reserveId: string) => void;
}

export function ReserveCard({ reserve, refreshing, onRefresh }: Props) {
  return (
    <div className="border border-zinc-800 rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Reserve</h2>
          <LifecycleBadge lifecycle={reserve.lifecycle} />
          <VersionBadge version={reserve.contractVersion} />
        </div>
        <button
          onClick={() => onRefresh(reserve.id)}
          disabled={refreshing}
          className="text-sm px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {refreshing ? "Refreshing..." : "Refresh from Chain"}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <p className="text-zinc-500">Value</p>
          <p className="font-mono">
            {formatCredits(BigInt(reserve.valueNanoErg))} ERG
          </p>
        </div>
        <div>
          <p className="text-zinc-500">Token</p>
          <p className="font-mono text-zinc-400">
            {reserve.reserveTokenId.substring(0, 16)}...
          </p>
        </div>
        <div>
          <p className="text-zinc-500">Customer</p>
          <p>
            <Link
              href={`/customer/${reserve.customer.id}`}
              className="text-blue-400 hover:underline"
            >
              {reserve.customer.name}
            </Link>
          </p>
        </div>
      </div>
      <p className="text-xs text-zinc-600">
        Last synced {new Date(reserve.updatedAt).toLocaleString()}
      </p>
    </div>
  );
}
