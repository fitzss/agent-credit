import { tracker } from "@/lib/tracker/service";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const history = await tracker.getNoteHistory(id);
  return NextResponse.json(history);
}
