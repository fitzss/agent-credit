import { readFile } from "node:fs/promises";
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
