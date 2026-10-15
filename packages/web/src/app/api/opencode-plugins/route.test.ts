import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
});
it("returns 400 for malformed JSON without contacting the control plane", async () => {
  const response = await POST(
    new NextRequest("https://test.local/api/opencode-plugins", { method: "POST", body: "{" })
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Invalid JSON body" });
  expect(controlPlaneUserFetch).not.toHaveBeenCalled();
});
it("forwards valid JSON and preserves the control-plane status", async () => {
  vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ id: "1" }, { status: 201 }));
  const response = await POST(
    new NextRequest("https://test.local/api/opencode-plugins", {
      method: "POST",
      body: '{"spec":"audit@1.0.0"}',
    })
  );
  expect(response.status).toBe(201);
  expect(controlPlaneUserFetch).toHaveBeenCalledWith("/opencode-plugins", {
    method: "POST",
    body: '{"spec":"audit@1.0.0"}',
  });
});
