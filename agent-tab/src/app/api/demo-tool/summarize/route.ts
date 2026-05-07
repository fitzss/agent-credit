import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "demo tools disabled in production" },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const text: string = body.text || body.content || body.query || "";
  const maxSentences: number = body.maxSentences || 3;

  if (!text) {
    return NextResponse.json({ error: "No text provided" }, { status: 400 });
  }

  const sentences = text.split(/(?<=[.!?])\s+/).filter((s: string) => s.trim().length > 0);
  const summary = sentences.slice(0, maxSentences).join(" ");

  return NextResponse.json({
    summary,
    originalLength: text.length,
    summaryLength: summary.length,
    sentencesExtracted: Math.min(sentences.length, maxSentences),
    totalSentences: sentences.length,
    compressionRatio: text.length > 0
      ? Math.round((summary.length / text.length) * 100) / 100
      : 0,
    timestamp: new Date().toISOString(),
  });
}
