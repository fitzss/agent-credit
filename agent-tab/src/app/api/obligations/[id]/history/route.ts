import { tracker } from "@/lib/tracker/service";
import { NextRequest, NextResponse } from "next/server";
import { toJsonSafe } from "@/lib/json-safe";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const history = await tracker.getNoteHistory(id);
  return NextResponse.json(toJsonSafe(history));
}
