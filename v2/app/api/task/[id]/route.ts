import { NextResponse } from "next/server";
import { runAction } from "@/lib/pueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: { id: string } }) {
  try {
    const body = (await request.json()) as { action?: string };
    if (!body.action) {
      return NextResponse.json({ ok: false, error: "Missing action" }, { status: 400 });
    }
    const result = await runAction(context.params.id, body.action);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
