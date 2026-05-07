import { NextRequest, NextResponse } from "next/server";

/**
 * LLM completion wrapper endpoint.
 * Forwards requests to the Anthropic Messages API, injecting the API key
 * from the environment. This keeps the upstream API key out of the database
 * and normalizes the request format.
 *
 * Accepts: { prompt: string, maxTokens?: number }
 * Returns: { completion: string, model: string, usage: {...}, timestamp: string }
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "demo tools disabled in production" },
      { status: 403 },
    );
  }

  const apiKey = process.env.UPSTREAM_LLM_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "UPSTREAM_LLM_API_KEY not configured" },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const prompt: string = body.prompt || body.text || body.query || "";
  const maxTokens: number = Math.min(body.maxTokens || 256, 1024);

  if (!prompt) {
    return NextResponse.json({ error: "No prompt provided" }, { status: 400 });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return NextResponse.json(
        { error: "Upstream LLM error", status: response.status, detail: err },
        { status: 502 }
      );
    }

    const data = await response.json();

    return NextResponse.json({
      completion: data.content?.[0]?.text || "",
      model: data.model,
      usage: data.usage,
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to reach upstream LLM" },
      { status: 502 }
    );
  }
}
