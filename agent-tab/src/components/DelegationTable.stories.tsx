import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { DelegationTable, DelegationRow } from "./DelegationTable";

const meta: Meta<typeof DelegationTable> = {
  title: "Components/DelegationTable",
  component: DelegationTable,
};
export default meta;

const sampleDelegations: DelegationRow[] = [
  {
    id: "del-1",
    customerId: "cust-1",
    customerName: "Demo Debtor",
    agentIdentityId: "agent-1",
    agentLabel: "auto-researcher",
    sessionPubKey: "03aabbccddee112233445566778899aabb",
    scopeProviders: "Bolt Tools",
    scopeTools: "All tools",
    spendCap: "20000000000",
    spentSoFar: "5000000000",
    utilization: 0.25,
    expiresAt: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
    timeRemainingMs: 6 * 24 * 3600_000,
    status: "active",
    complianceState: "active",
  },
  {
    id: "del-2",
    customerId: "cust-1",
    customerName: "Demo Debtor",
    agentIdentityId: "agent-2",
    agentLabel: "code-assistant",
    sessionPubKey: "03112233445566778899aabbccddeeff00",
    scopeProviders: "All providers",
    scopeTools: "All tools",
    spendCap: "10000000000",
    spentSoFar: "8500000000",
    utilization: 0.85,
    expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
    timeRemainingMs: 2 * 3600_000,
    status: "active",
    complianceState: "approaching-cap",
  },
  {
    id: "del-3",
    customerId: "cust-1",
    customerName: "Demo Debtor",
    agentIdentityId: null,
    agentLabel: null,
    sessionPubKey: "03ffeeddccbbaa998877665544332211ff",
    scopeProviders: "All providers",
    scopeTools: "All tools",
    spendCap: "50000000000",
    spentSoFar: "50000000000",
    utilization: 1.0,
    expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    timeRemainingMs: -3600_000,
    status: "expired",
    complianceState: "expired",
  },
];

export const Default: StoryObj<typeof DelegationTable> = {
  args: {
    delegations: sampleDelegations,
    revokingId: null,
    confirmRevokeId: null,
    onRequestRevoke: () => {},
    onConfirmRevoke: () => {},
    onCancelRevoke: () => {},
  },
};

export const ConfirmingRevoke: StoryObj<typeof DelegationTable> = {
  args: {
    delegations: sampleDelegations,
    revokingId: null,
    confirmRevokeId: "del-2",
    onRequestRevoke: () => {},
    onConfirmRevoke: () => {},
    onCancelRevoke: () => {},
  },
};
