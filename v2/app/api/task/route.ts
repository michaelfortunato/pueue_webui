import { NextResponse } from "next/server";

const BACKEND_URL = process.env.PUEUE_V2_BACKEND_URL ?? "http://127.0.0.1:9093";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body?.command || typeof body.command !== "string") {
      return NextResponse.json({ ok: false, error: "Missing command" }, { status: 400 });
    }
    const response = await fetch(`${BACKEND_URL}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    return NextResponse.json(json, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
