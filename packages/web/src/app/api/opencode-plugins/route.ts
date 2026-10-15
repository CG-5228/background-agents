import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneUserFetch("/opencode-plugins");
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch OpenCode plugins:", error);
    return NextResponse.json({ error: "Failed to fetch OpenCode plugins" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const response = await controlPlaneUserFetch("/opencode-plugins", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to create OpenCode plugin:", error);
    return NextResponse.json({ error: "Failed to create OpenCode plugin" }, { status: 500 });
  }
}
