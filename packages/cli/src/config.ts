import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const ToolEntry = z.object({
  id: z.string().min(1),
  upstreamName: z.string().min(1),
  exposedName: z.string().min(1),
  costPerCall: z.string().regex(/^\d+$/, "costPerCall must be an unsigned integer string"),
});

const TabEntry = z.object({
  id: z.string().min(1),
  scope: z.string().default("*"),
  limitAmount: z.string().regex(/^\d+$/, "limitAmount must be an unsigned integer string"),
});

const Upstream = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
});

export const ConfigSchema = z.object({
  version: z.literal(1),
  stateDir: z.string().min(1),
  upstream: Upstream,
  tools: z.array(ToolEntry).min(1),
  tabs: z.array(TabEntry).min(1),
  defaultTabId: z.string().min(1).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ToolEntry = z.infer<typeof ToolEntry>;
export type TabEntry = z.infer<typeof TabEntry>;

export async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Config ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Config ${path} failed validation:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}

// Atomic write: temp + rename in the same directory.
export async function writeConfig(path: string, config: Config): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

export function defaultTabFor(config: Config): TabEntry {
  if (config.defaultTabId) {
    const found = config.tabs.find((t) => t.id === config.defaultTabId);
    if (found) return found;
  }
  return config.tabs[0];
}
