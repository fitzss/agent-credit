import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  PoolStatusBadge,
  ReadinessBadge,
  LifecycleBadge,
  VersionBadge,
  AuthorityModeBadge,
  ComplianceBadge,
  MethodBadge,
  EnvironmentBadge,
} from "./badges";

/* ---- Pool Status ---- */

const poolStatusMeta: Meta<typeof PoolStatusBadge> = {
  title: "Badges/Pool Status",
  component: PoolStatusBadge,
};
export default poolStatusMeta;

export const Healthy: StoryObj<typeof PoolStatusBadge> = {
  args: { status: "healthy" },
};
export const LowCoverage: StoryObj<typeof PoolStatusBadge> = {
  args: { status: "low-coverage" },
};
export const Depleted: StoryObj<typeof PoolStatusBadge> = {
  args: { status: "depleted" },
};
export const Offline: StoryObj<typeof PoolStatusBadge> = {
  args: { status: "offline" },
};

/* ---- Readiness ---- */

export const ReadyToSettle: StoryObj<typeof ReadinessBadge> = {
  render: () => <ReadinessBadge readiness="ready" />,
};
export const NoDebt: StoryObj<typeof ReadinessBadge> = {
  render: () => <ReadinessBadge readiness="no-debt" />,
};
export const PendingRedemption: StoryObj<typeof ReadinessBadge> = {
  render: () => <ReadinessBadge readiness="pending-redemption" />,
};
export const InsufficientReserve: StoryObj<typeof ReadinessBadge> = {
  render: () => <ReadinessBadge readiness="insufficient-reserve" />,
};

/* ---- Lifecycle ---- */

export const ActiveReserve: StoryObj<typeof LifecycleBadge> = {
  render: () => <LifecycleBadge lifecycle="active" />,
};
export const DepletedReserve: StoryObj<typeof LifecycleBadge> = {
  render: () => <LifecycleBadge lifecycle="depleted" />,
};

/* ---- Authority Mode ---- */

export const DelegatedAuthority: StoryObj<typeof AuthorityModeBadge> = {
  render: () => <AuthorityModeBadge mode="delegated" />,
};
export const TrackerManaged: StoryObj<typeof AuthorityModeBadge> = {
  render: () => <AuthorityModeBadge mode="tracker-managed" />,
};

/* ---- Compliance ---- */

export const ActiveDelegation: StoryObj<typeof ComplianceBadge> = {
  render: () => <ComplianceBadge state="active" />,
};
export const NearingCap: StoryObj<typeof ComplianceBadge> = {
  render: () => <ComplianceBadge state="approaching-cap" />,
};
export const NearingExpiry: StoryObj<typeof ComplianceBadge> = {
  render: () => <ComplianceBadge state="approaching-expiry" />,
};
export const Exhausted: StoryObj<typeof ComplianceBadge> = {
  render: () => <ComplianceBadge state="exhausted" />,
};
export const Expired: StoryObj<typeof ComplianceBadge> = {
  render: () => <ComplianceBadge state="expired" />,
};
export const Revoked: StoryObj<typeof ComplianceBadge> = {
  render: () => <ComplianceBadge state="revoked" />,
};

/* ---- Version ---- */

export const V2Contract: StoryObj<typeof VersionBadge> = {
  render: () => <VersionBadge version="v2" />,
};
export const V1Contract: StoryObj<typeof VersionBadge> = {
  render: () => <VersionBadge version="v1" />,
};

/* ---- Method ---- */

export const OnChain: StoryObj<typeof MethodBadge> = {
  render: () => <MethodBadge method="on-chain-redemption" />,
};

/* ---- Environment ---- */

export const Testnet: StoryObj<typeof EnvironmentBadge> = {
  render: () => <EnvironmentBadge env="testnet" />,
};
export const Mainnet: StoryObj<typeof EnvironmentBadge> = {
  render: () => <EnvironmentBadge env="mainnet" />,
};
export const Local: StoryObj<typeof EnvironmentBadge> = {
  render: () => <EnvironmentBadge env="local" />,
};

/* ---- All badges gallery ---- */

export const AllBadges: StoryObj = {
  render: () => (
    <div className="space-y-6 text-sm">
      <div>
        <p className="text-zinc-500 mb-2">Pool Status</p>
        <div className="flex gap-2">
          <PoolStatusBadge status="healthy" />
          <PoolStatusBadge status="low-coverage" />
          <PoolStatusBadge status="depleted" />
          <PoolStatusBadge status="offline" />
        </div>
      </div>
      <div>
        <p className="text-zinc-500 mb-2">Settlement Readiness</p>
        <div className="flex gap-2">
          <ReadinessBadge readiness="ready" />
          <ReadinessBadge readiness="no-debt" />
          <ReadinessBadge readiness="pending-redemption" />
          <ReadinessBadge readiness="insufficient-reserve" />
        </div>
      </div>
      <div>
        <p className="text-zinc-500 mb-2">Authority Mode</p>
        <div className="flex gap-2">
          <AuthorityModeBadge mode="delegated" />
          <AuthorityModeBadge mode="tracker-managed" />
        </div>
      </div>
      <div>
        <p className="text-zinc-500 mb-2">Delegation Compliance</p>
        <div className="flex gap-2">
          <ComplianceBadge state="active" />
          <ComplianceBadge state="approaching-cap" />
          <ComplianceBadge state="approaching-expiry" />
          <ComplianceBadge state="exhausted" />
          <ComplianceBadge state="expired" />
          <ComplianceBadge state="revoked" />
        </div>
      </div>
      <div>
        <p className="text-zinc-500 mb-2">Environment</p>
        <div className="flex gap-2">
          <EnvironmentBadge env="testnet" />
          <EnvironmentBadge env="mainnet" />
          <EnvironmentBadge env="local" />
        </div>
      </div>
    </div>
  ),
};
