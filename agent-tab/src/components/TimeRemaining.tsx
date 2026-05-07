export function TimeRemaining({ ms }: { ms: number }) {
  if (ms <= 0) return <span className="text-red-400">Expired</span>;
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days > 0)
    return (
      <span>
        {days}d {remainingHours}h
      </span>
    );
  if (hours > 0) {
    const mins = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    return (
      <span>
        {hours}h {mins}m
      </span>
    );
  }
  const mins = Math.floor(ms / (1000 * 60));
  return <span className="text-yellow-400">{mins}m</span>;
}
