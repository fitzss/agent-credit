/**
 * Horizontal bar showing spend / authority utilization.
 * Colors shift from green → yellow → red as utilization increases.
 */
export function UtilizationBar({ ratio }: { ratio: number }) {
  const pct = Math.min(ratio * 100, 100);
  const color =
    ratio >= 0.9
      ? "bg-red-500"
      : ratio >= 0.7
        ? "bg-yellow-500"
        : "bg-green-500";

  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-zinc-500">{Math.round(pct)}%</span>
    </div>
  );
}
