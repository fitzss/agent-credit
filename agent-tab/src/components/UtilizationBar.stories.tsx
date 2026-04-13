import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { UtilizationBar } from "./UtilizationBar";

const meta: Meta<typeof UtilizationBar> = {
  title: "Components/UtilizationBar",
  component: UtilizationBar,
};
export default meta;

export const Low: StoryObj<typeof UtilizationBar> = {
  args: { ratio: 0.25 },
};

export const Medium: StoryObj<typeof UtilizationBar> = {
  args: { ratio: 0.6 },
};

export const High: StoryObj<typeof UtilizationBar> = {
  args: { ratio: 0.78 },
};

export const Critical: StoryObj<typeof UtilizationBar> = {
  args: { ratio: 0.95 },
};

export const Full: StoryObj<typeof UtilizationBar> = {
  args: { ratio: 1.0 },
};

export const AllStates: StoryObj = {
  render: () => (
    <div className="space-y-3 w-48">
      <div className="flex items-center gap-3">
        <span className="text-xs text-zinc-500 w-16">25%</span>
        <UtilizationBar ratio={0.25} />
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-zinc-500 w-16">60%</span>
        <UtilizationBar ratio={0.6} />
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-zinc-500 w-16">78%</span>
        <UtilizationBar ratio={0.78} />
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-zinc-500 w-16">95%</span>
        <UtilizationBar ratio={0.95} />
      </div>
    </div>
  ),
};
