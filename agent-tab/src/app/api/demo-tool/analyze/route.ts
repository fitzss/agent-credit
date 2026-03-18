import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const text: string = body.text || body.content || body.query || "";

  if (!text) {
    return NextResponse.json({ error: "No text provided" }, { status: 400 });
  }

  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter((s: string) => s.trim().length > 0);
  const avgWordLength = words.length > 0
    ? words.reduce((sum: number, w: string) => sum + w.length, 0) / words.length
    : 0;

  // Simple readability estimate (Coleman-Liau-like)
  const readingLevel = Math.min(
    Math.max(Math.round(0.0588 * (avgWordLength * 17) - 0.296 * (sentences.length / Math.max(words.length, 1) * 100) - 15.8), 1),
    16
  );

  return NextResponse.json({
    characters: text.length,
    words: words.length,
    sentences: sentences.length,
    averageWordLength: Math.round(avgWordLength * 100) / 100,
    readingLevel: `Grade ${readingLevel}`,
    timestamp: new Date().toISOString(),
  });
}
