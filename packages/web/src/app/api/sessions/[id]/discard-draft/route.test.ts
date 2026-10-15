import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

function discard(id: string) {
  return POST(
    new Request(`http://localhost/api/sessions/${id}/discard-draft`, {
      method: "POST",
    }) as never,
    { params: Promise.resolve({ id }) }
  );
}

describe("discard draft API route", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    [200, { outcome: "discarded" }],
    [200, { outcome: "not_draft" }],
    [403, { error: "Forbidden" }],
    [404, { error: "Session not found" }],
  ])("proxies the control plane's %i answer", async (status, body) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(body, { status }));

    const response = await discard("session-1");

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session-1/discard-draft", {
      method: "POST",
    });
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(body);
  });

  it("encodes the session id into one path segment", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ outcome: "discarded" }));
    await discard("a/b");
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/a%2Fb/discard-draft", {
      method: "POST",
    });
  });

  it("answers 500 when the control plane is unreachable", async () => {
    vi.mocked(controlPlaneUserFetch).mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await discard("session-1")).status).toBe(500);
  });
});
