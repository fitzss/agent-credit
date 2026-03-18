import { tracker, TrackerError } from "@/lib/tracker/service";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const proof = await tracker.getNoteProof(id);
    return NextResponse.json(proof);
  } catch (e) {
    if (e instanceof TrackerError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    throw e;
  }
}
