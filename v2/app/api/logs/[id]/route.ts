import { NextResponse } from "next/server";
import { getLog } from "@/lib/pueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: { id: string } }) {
  try {
    const log = await getLog(context.params.id);
    return NextResponse.json({ ok: true, log });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
