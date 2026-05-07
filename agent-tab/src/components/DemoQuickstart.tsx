"use client";

import { useState } from "react";

interface CommandStep {
  label: string;
  command: string;
  hint?: string;
}

const SERVICE_STEPS: CommandStep[] = [
  {
    label: "Start the Ergo testnet node",
    command:
      "cd <ergo-node-dir> && java -jar ergo-5.0.14.jar --testnet -c ergo.conf",
    hint: "Skip if already running on port 9052.",
  },
  {
    label: "Unlock the wallet",
    command:
      "curl -X POST http://localhost:9052/wallet/unlock -H 'api_key: hello' -H 'Content-Type: application/json' -d '{\"pass\":\"hello\"}'",
    hint: "Idempotent. Safe to re-run.",
  },
  {
    label: "Start the ChainCash sidecar",
    command: 'cd chaincash && sbt "runMain chaincash.sidecar.SidecarServer"',
    hint: "Skip if already running on port 8081.",
  },
  {
    label: "Start the Agent Tab",
    command: "cd agent-tab && DEMO_MODE=true npx next dev -p 3000",
    hint: "This is what you are looking at right now.",
  },
];

const DEMO_STEPS: CommandStep[] = [
  {
    label: "Seed the bounded-buyer fixture (Bolt Labs)",
    command: "cd agent-tab && npx tsx scripts/seed-authority-demo.ts",
    hint: "Creates the customer, agents, providers, and seeded delegations on this pool.",
  },
  {
    label: "Run the OpenClaw caller end-to-end",
    command:
      "cd agent-tab && npx tsx scripts/openclaw-caller.ts --mode=demo",
    hint: "One charged call, then one over-cap call. Use --cleanup between sessions.",
  },
];

const REPO_LINT_STEPS: CommandStep[] = [
  {
    label: "Seed the repo-lint demo lane (Demo Debtor ↔ Repo Tools)",
    command:
      "cd agent-tab && npx tsx scripts/seed-repo-lint-demo.ts --reset && npx tsx scripts/seed-repo-lint-demo.ts --limit-amount 100000000",
    hint: "Dedicated provider — won't collide with the analyze_text lane. Prints a raw API key once.",
  },
  {
    label: "Run the MCP gateway against the lint tool",
    command:
      "AGENT_TAB_MCP_TOOL_NAME=budgeted_repo_lint AGENT_TAB_MCP_INPUT_SHAPE=none AGENT_TAB_TOOL_ID=mcp-demo-tool-repo-lint-001 npx tsx scripts/mcp-gateway/index.ts",
    hint: "Set AGENT_TAB_BASE_URL and AGENT_TAB_AGENT_KEY from the seeder output. Call once → Work Receipt; call again → Denied.",
  },
];

function CommandRow({ step }: { step: CommandStep }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(step.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; user can still select the text manually
    }
  };

  return (
    <div className="space-y-1">
      <p className="text-sm text-zinc-300">{step.label}</p>
      <div className="flex items-start gap-2">
        <code className="flex-1 block text-xs font-mono bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-zinc-200 break-all">
          {step.command}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="text-xs px-2 py-2 text-zinc-500 hover:text-white border border-zinc-800 rounded transition-colors"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {step.hint && <p className="text-xs text-zinc-500">{step.hint}</p>}
    </div>
  );
}

export function DemoQuickstart() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="border border-blue-900/50 rounded-lg bg-blue-950/10">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-blue-900/10 transition-colors rounded-t-lg"
        aria-expanded={!collapsed}
      >
        <div className="flex items-center gap-3">
          <span className="text-blue-400 text-sm font-mono">
            {collapsed ? "▸" : "▾"}
          </span>
          <div>
            <h3 className="text-base font-semibold text-blue-300">
              Bounded-buyer demo runbook
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Local testnet only. Not production, not mainnet.
            </p>
          </div>
        </div>
        <span className="text-xs text-zinc-500">
          {collapsed ? "expand" : "collapse"}
        </span>
      </button>

      {!collapsed && (
        <div className="px-5 pb-5 pt-1 space-y-5">
          <section className="space-y-3">
            <h4 className="text-xs uppercase tracking-wide text-zinc-500">
              1. Bring up the local services
            </h4>
            <div className="space-y-3">
              {SERVICE_STEPS.map((s) => (
                <CommandRow key={s.label} step={s} />
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h4 className="text-xs uppercase tracking-wide text-zinc-500">
              2. Run the bounded-buyer demo
            </h4>
            <div className="space-y-3">
              {DEMO_STEPS.map((s) => (
                <CommandRow key={s.label} step={s} />
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h4 className="text-xs uppercase tracking-wide text-zinc-500">
              3. (Optional) Run the repo-lint receipt demo
            </h4>
            <div className="space-y-3">
              {REPO_LINT_STEPS.map((s) => (
                <CommandRow key={s.label} step={s} />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h4 className="text-xs uppercase tracking-wide text-zinc-500">
              4. What success looks like on this page
            </h4>
            <ul className="text-sm text-zinc-300 space-y-1.5 list-disc list-inside marker:text-zinc-600">
              <li>
                A new agent-bound delegation appears in{" "}
                <span className="text-zinc-400">Agent Authority</span>.
              </li>
              <li>
                <span className="text-zinc-400">Recent Agent Activity</span>{" "}
                shows one{" "}
                <span className="text-green-400">Work Receipt</span> row and one{" "}
                <span className="text-red-400">Denied</span> row (no receipt, no
                state moved).
              </li>
              <li>
                The charged delegation&apos;s utilization advances by exactly{" "}
                <span className="font-mono text-zinc-200">$0.10</span>.
              </li>
              <li>
                The denied call does not move{" "}
                <span className="text-zinc-400">spentSoFar</span> or any
                obligation balance — the cap held.
              </li>
            </ul>
          </section>

          <p className="text-xs text-zinc-500 pt-1 border-t border-zinc-800">
            Full walkthrough lives in the repo at{" "}
            <code className="text-zinc-400">
              agent-tab/docs/demo-walkthrough.md
            </code>
            . Architecture overview at{" "}
            <code className="text-zinc-400">CLAUDE.md</code>.
          </p>
        </div>
      )}
    </div>
  );
}
