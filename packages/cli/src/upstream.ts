import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "./config.js";

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class Upstream {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private callCount = 0;

  async connect(config: Config): Promise<void> {
    this.transport = new StdioClientTransport({
      command: config.upstream.command,
      args: config.upstream.args,
      env: { ...process.env, ...config.upstream.env } as Record<string, string>,
    });
    this.client = new Client(
      { name: "@agent-tab/cli proxy", version: "0.0.1" },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<UpstreamTool[]> {
    if (!this.client) throw new Error("upstream not connected");
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error("upstream not connected");
    this.callCount += 1;
    return await this.client.callTool({ name, arguments: args });
  }

  getCallCount(): number {
    return this.callCount;
  }

  async close(): Promise<void> {
    try {
      if (this.transport) await this.transport.close();
    } catch {
      // ignore
    }
    this.client = null;
    this.transport = null;
  }
}
