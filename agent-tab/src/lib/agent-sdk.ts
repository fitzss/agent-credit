/**
 * Agent Tab SDK — client library for agents using tools on credit.
 *
 * Wraps the two-round-trip delegated signing flow into a single callTool() operation:
 * 1. Proxy call → get tool response + pending canonical message
 * 2. Sign locally with session key → submit signature to tracker
 *
 * The session private key never leaves the agent's process.
 *
 * Usage:
 *   const client = new AgentTabClient({
 *     apiKey: "agent-key-demo-003",
 *     sessionPrivateKey: "hex...",      // optional: for self-custody delegated signing
 *     sessionPubKey: "hex...",          // optional: must match delegation
 *     delegationId: "uuid",            // optional: specific delegation to use
 *     baseUrl: "http://localhost:3000",
 *   });
 *
 *   const result = await client.callTool("tool-id", { text: "input" });
 */

// Dynamic import for secp256k1 — works in both Node and browser
async function signWithSessionKey(
  canonicalMessage: string,
  sessionPrivateKeyHex: string
): Promise<string> {
  // Use dynamic import to support both environments
  const secp = await import("@noble/secp256k1");

  // Ensure hashes are configured (Node.js needs this for secp256k1 v3)
  if (!secp.hashes.sha256 && !secp.hashes.sha256Async) {
    if (typeof globalThis.crypto?.subtle !== "undefined") {
      secp.hashes.sha256Async = async (msg: Uint8Array) => {
        const copy = new Uint8Array(msg);
        return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
      };
      secp.hashes.hmacSha256Async = async (key: Uint8Array, msg: Uint8Array) => {
        const keyCopy = new Uint8Array(key);
        const msgCopy = new Uint8Array(msg);
        const cryptoKey = await crypto.subtle.importKey(
          "raw", keyCopy, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
        );
        return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msgCopy));
      };
    }
  }

  const msgBytes = new TextEncoder().encode(canonicalMessage);
  const privKeyBytes = secp.etc.hexToBytes(sessionPrivateKeyHex);
  const sig = await secp.signAsync(msgBytes, privKeyBytes);
  return secp.etc.bytesToHex(sig);
}

export interface AgentTabClientOptions {
  apiKey: string;
  sessionPrivateKey?: string;
  sessionPubKey?: string;
  delegationId?: string;
  baseUrl: string;
}

export interface CallToolResult {
  toolResponse: Record<string, unknown>;
  toolStatus: number;
  tab: {
    balance: string;
    pending: string;
    limit: string;
    remaining: string;
    utilization: number;
    version: number;
    signature: string | null;
    alert: string | null;
    signed: boolean;
    delegated: boolean;
  };
}

export class AgentTabClient {
  private apiKey: string;
  private sessionPrivateKey?: string;
  private sessionPubKey?: string;
  private delegationId?: string;
  private baseUrl: string;

  constructor(opts: AgentTabClientOptions) {
    this.apiKey = opts.apiKey;
    this.sessionPrivateKey = opts.sessionPrivateKey;
    this.sessionPubKey = opts.sessionPubKey;
    this.delegationId = opts.delegationId;
    this.baseUrl = opts.baseUrl;
  }

  async callTool(toolId: string, body: Record<string, unknown>): Promise<CallToolResult> {
    // Round trip 1: proxy call
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-agent-api-key": this.apiKey,
      "x-tool-id": toolId,
    };
    if (this.sessionPubKey) {
      headers["x-session-pubkey"] = this.sessionPubKey;
    }

    const proxyRes = await fetch(`${this.baseUrl}/api/proxy`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const proxyData = await proxyRes.json();

    // If error or tracker-managed (already signed), return directly
    if (proxyData.error || !proxyData.tab?.pendingSignature) {
      return {
        toolResponse: proxyData.toolResponse ?? proxyData,
        toolStatus: proxyData.toolStatus ?? proxyRes.status,
        tab: {
          ...proxyData.tab,
          signed: !proxyData.tab?.pendingSignature,
          delegated: false,
          pending: proxyData.tab?.pending ?? 0,
        },
      };
    }

    // Round trip 2: sign and submit (self-custody / delegated)
    if (!this.sessionPrivateKey) {
      // No session key — return pending result for manual signing
      return {
        toolResponse: proxyData.toolResponse,
        toolStatus: proxyData.toolStatus,
        tab: {
          ...proxyData.tab,
          signed: false,
          delegated: false,
        },
      };
    }

    // Sign locally — private key never leaves this process
    const signature = await signWithSessionKey(
      proxyData.tab.canonicalMessage,
      this.sessionPrivateKey
    );

    // Submit signature to tracker
    const signRes = await fetch(
      `${this.baseUrl}/api/obligations/${proxyData.tab.obligationId}/sign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signature,
          updateId: proxyData.tab.updateId,
          delegationId: this.delegationId ?? proxyData.tab.delegationId,
        }),
      }
    );
    const signData = await signRes.json();

    if (signData.error) {
      return {
        toolResponse: proxyData.toolResponse,
        toolStatus: proxyData.toolStatus,
        tab: {
          ...proxyData.tab,
          signed: false,
          delegated: false,
          signError: signData.error,
        },
      };
    }

    return {
      toolResponse: proxyData.toolResponse,
      toolStatus: proxyData.toolStatus,
      tab: {
        balance: signData.obligation.currentAmount,
        pending: signData.obligation.pendingAmount,
        limit: proxyData.tab.limit,
        remaining: (BigInt(proxyData.tab.limit) - BigInt(signData.obligation.currentAmount) - BigInt(signData.obligation.pendingAmount)).toString(),
        utilization: proxyData.tab.utilization,
        version: signData.version,
        signature,
        alert: proxyData.tab.alert,
        signed: true,
        delegated: !!this.delegationId,
      },
    };
  }
}
