import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

// The control plane authenticates the forwarded session cookie and authorizes
// the discard like an archive, so no separate session lookup happens here.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const response = await controlPlaneUserFetch(
      `/sessions/${encodeURIComponent(id)}/discard-draft`,
      { method: "POST" }
    );
    const data = await response.json().catch(() => null);
    return NextResponse.json(data ?? {}, { status: response.status });
  } catch (error) {
    console.error("Discard draft session error:", error);
    return NextResponse.json({ error: "Failed to discard draft session" }, { status: 500 });
  }
}
