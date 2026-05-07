import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { StatCard } from "./StatCard";

const meta: Meta<typeof StatCard> = {
  title: "Components/StatCard",
  component: StatCard,
};
export default meta;

export const ReserveBacking: StoryObj<typeof StatCard> = {
  args: { label: "Reserve Backing", value: "5.00 ERG" },
};

export const OutstandingObligations: StoryObj<typeof StatCard> = {
  args: { label: "Outstanding Obligations", value: "3.50 credits" },
};

export const Coverage: StoryObj<typeof StatCard> = {
  args: { label: "Coverage", value: "143%" },
};

export const SummaryStrip: StoryObj = {
  render: () => (
    <div className="grid grid-cols-4 gap-4">
      <StatCard label="Reserve Backing" value="5.00 ERG" />
      <StatCard label="Outstanding Obligations" value="3.50 credits" />
      <StatCard label="Coverage" value="143%" />
      <StatCard label="Active Delegations" value="3" />
    </div>
  ),
};
