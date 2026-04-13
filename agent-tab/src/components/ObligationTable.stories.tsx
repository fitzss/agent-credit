import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ObligationTable, ObligationRow } from "./ObligationTable";

const meta: Meta<typeof ObligationTable> = {
  title: "Components/ObligationTable",
  component: ObligationTable,
};
export default meta;

const sampleObligations: ObligationRow[] = [
  {
    id: "obl-1",
    providerId: "prov-1",
    providerName: "Bolt Tools",
    customerId: "cust-1",
    customerName: "Demo Debtor",
    currentAmount: "1500000000",
    version: 3,
    settlementStatus: "current",
    debtorPubKey: "03abc123...",
    creditorPubKey: "03def456...",
    latestSignature: "sig-data",
    creditLimit: "5000000000",
    alertThreshold: 0.8,
    reserveId: "res-1",
    settlementReadiness: "ready",
  },
  {
    id: "obl-2",
    providerId: "prov-2",
    providerName: "CodeGen AI",
    customerId: "cust-1",
    customerName: "Demo Debtor",
    currentAmount: "4200000000",
    version: 7,
    settlementStatus: "current",
    debtorPubKey: "03abc123...",
    creditorPubKey: "03ghi789...",
    latestSignature: "sig-data",
    creditLimit: "5000000000",
    alertThreshold: 0.8,
    reserveId: "res-1",
    settlementReadiness: "insufficient-reserve",
  },
  {
    id: "obl-3",
    providerId: "prov-3",
    providerName: "SearchAPI",
    customerId: "cust-1",
    customerName: "Demo Debtor",
    currentAmount: "0",
    version: 1,
    settlementStatus: "settled",
    debtorPubKey: "03abc123...",
    creditorPubKey: "03jkl012...",
    latestSignature: null,
    creditLimit: "3000000000",
    alertThreshold: null,
    reserveId: "res-1",
    settlementReadiness: "no-debt",
  },
];

export const Default: StoryObj<typeof ObligationTable> = {
  args: {
    obligations: sampleObligations,
    redeemingId: null,
    redeemResult: null,
    onRedeem: () => {},
    onDismissResult: () => {},
  },
};

export const Empty: StoryObj<typeof ObligationTable> = {
  args: {
    obligations: [],
    redeemingId: null,
    redeemResult: null,
    onRedeem: () => {},
    onDismissResult: () => {},
  },
};

export const WithRedeemSuccess: StoryObj<typeof ObligationTable> = {
  args: {
    obligations: sampleObligations,
    redeemingId: null,
    redeemResult: {
      obligationId: "obl-1",
      success: true,
      message: "Settled — obligation now reconciled",
    },
    onRedeem: () => {},
    onDismissResult: () => {},
  },
};

export const WithRedeemError: StoryObj<typeof ObligationTable> = {
  args: {
    obligations: sampleObligations,
    redeemingId: null,
    redeemResult: {
      obligationId: "obl-2",
      success: false,
      message: "Insufficient reserve to cover obligation",
    },
    onRedeem: () => {},
    onDismissResult: () => {},
  },
};

export const Redeeming: StoryObj<typeof ObligationTable> = {
  args: {
    obligations: sampleObligations,
    redeemingId: "obl-1",
    redeemResult: null,
    onRedeem: () => {},
    onDismissResult: () => {},
  },
};
