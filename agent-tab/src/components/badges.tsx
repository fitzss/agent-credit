/**
 * Status badges for the agent-credit operator UI.
 *
 * Badge language is intentionally commercial/operator-grade,
 * not generic fintech. Every badge answers: "what state is this in,
 * and does it need attention?"
 */

/* ---- Pool health ---- */

const poolStatusStyles: Record<string, string> = {
  healthy: "bg-green-900/50 text-green-400",
  "low-coverage": "bg-yellow-900/50 text-yellow-400",
  depleted: "bg-red-900/50 text-red-400",
  offline: "bg-zinc-800 text-zinc-400",
};

const poolStatusLabels: Record<string, string> = {
  healthy: "Healthy",
  "low-coverage": "Low Coverage",
  depleted: "Depleted",
  offline: "Offline",
};

export function PoolStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block px-2.5 py-1 text-sm rounded-full font-medium ${poolStatusStyles[status] || poolStatusStyles.offline}`}
    >
      {poolStatusLabels[status] || status}
    </span>
  );
}

/* ---- Settlement readiness ---- */

const readinessStyles: Record<string, string> = {
  ready: "bg-green-900/50 text-green-400",
  "no-debt": "bg-zinc-800 text-zinc-400",
  "pending-redemption": "bg-yellow-900/50 text-yellow-400",
  "insufficient-reserve": "bg-red-900/50 text-red-400",
  "reserve-inactive": "bg-zinc-800 text-zinc-400",
};

const readinessLabels: Record<string, string> = {
  ready: "Ready to Settle",
  "no-debt": "No Debt",
  "pending-redemption": "Pending Redemption",
  "insufficient-reserve": "Insufficient Reserve",
  "reserve-inactive": "Reserve Inactive",
};

export function ReadinessBadge({ readiness }: { readiness: string }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs rounded-full ${readinessStyles[readiness] || readinessStyles["no-debt"]}`}
    >
      {readinessLabels[readiness] || readiness}
    </span>
  );
}

/* ---- Reserve lifecycle ---- */

const lifecycleStyles: Record<string, string> = {
  active: "bg-green-900/50 text-green-400",
  requested: "bg-zinc-800 text-zinc-400",
  submitted: "bg-yellow-900/50 text-yellow-400",
  depleted: "bg-red-900/50 text-red-400",
};

export function LifecycleBadge({ lifecycle }: { lifecycle: string }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs rounded-full ${lifecycleStyles[lifecycle] || "bg-zinc-800 text-zinc-400"}`}
    >
      {lifecycle}
    </span>
  );
}

/* ---- Contract version ---- */

export function VersionBadge({ version }: { version: string }) {
  const isV2 = version === "v2";
  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs rounded-full ${isV2 ? "bg-blue-900/50 text-blue-400" : "bg-zinc-800 text-zinc-400"}`}
    >
      {version}
    </span>
  );
}

/* ---- Authority mode ---- */

export function AuthorityModeBadge({ mode }: { mode: string }) {
  if (mode === "delegated") {
    return (
      <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-blue-900/50 text-blue-400">
        Delegated Authority
      </span>
    );
  }
  return (
    <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-zinc-800 text-zinc-400">
      Tracker-Managed
    </span>
  );
}

/* ---- Delegation compliance ---- */

const complianceStyles: Record<string, string> = {
  active: "bg-green-900/50 text-green-400",
  "approaching-cap": "bg-yellow-900/50 text-yellow-400",
  "approaching-expiry": "bg-yellow-900/50 text-yellow-400",
  exhausted: "bg-red-900/50 text-red-400",
  expired: "bg-red-900/50 text-red-400",
  revoked: "bg-zinc-800 text-zinc-400",
};

const complianceLabels: Record<string, string> = {
  active: "Active",
  "approaching-cap": "Nearing Cap",
  "approaching-expiry": "Nearing Expiry",
  exhausted: "Exhausted",
  expired: "Expired",
  revoked: "Revoked",
};

export function ComplianceBadge({ state }: { state: string }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs rounded-full ${complianceStyles[state] || complianceStyles.revoked}`}
    >
      {complianceLabels[state] || state}
    </span>
  );
}

/* ---- Settlement method ---- */

export function MethodBadge({ method }: { method: string }) {
  if (method === "on-chain-redemption") {
    return (
      <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-blue-900/50 text-blue-400">
        On-Chain
      </span>
    );
  }
  return (
    <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-zinc-800 text-zinc-400">
      {method}
    </span>
  );
}

/* ---- Environment ---- */

export function EnvironmentBadge({ env }: { env: string }) {
  const styles: Record<string, string> = {
    testnet: "bg-purple-900/50 text-purple-400",
    mainnet: "bg-green-900/50 text-green-400",
    local: "bg-zinc-800 text-zinc-400",
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs rounded-full ${styles[env] || styles.local}`}
    >
      {env}
    </span>
  );
}
