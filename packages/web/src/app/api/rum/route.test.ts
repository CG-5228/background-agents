import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("next/headers", () => ({ headers: vi.fn() }));

const PAGE_LOAD_ID = "550e8400-e29b-41d4-a716-446655440000";
const payload = {
  v: 1,
  pageLoadId: PAGE_LOAD_ID,
  seq: 1,
  reason: "hidden",
  path: "/",
};

function beacon(body: string = JSON.stringify(payload), extraHeaders: Record<string, string> = {}) {
  return new NextRequest("https://app.example.com/api/rum", {
    method: "POST",
    headers: {
      Origin: "https://app.example.com",
      "Content-Type": "text/plain;charset=UTF-8",
      ...extraHeaders,
    },
    body,
  });
}

describe("POST /api/rum", () => {
  beforeEach(() => {
    vi.stubEnv("LOG_LEVEL", "info");
    vi.stubEnv("VERCEL_REGION", "test-region");
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-trace-id": "not-the-page-load-id",
        "x-open-inspect-request-id": "rumreq01",
      })
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("accepts a text/plain beacon and emits exactly one structured event", async () => {
    const response = await POST(
      beacon(
        JSON.stringify({
          ...payload,
          navigationType: "reload",
          milestones: {
            auth_cleared: 0,
            sidebar_populated: 100,
            composer_ready: 200,
            picker_ready: 600_000,
          },
          vitals: [
            { name: "CLS", value: 0, rating: "good", id: "cls-1" },
            { name: "FCP", value: 123.5, rating: "good", id: "fcp-1" },
            { name: "INP", value: 250, rating: "needs-improvement", id: "inp-1" },
            { name: "LCP", value: 4500, rating: "poor", id: "lcp-1" },
            { name: "TTFB", value: 42.5, rating: "good", id: "ttfb-1" },
          ],
        })
      )
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
      level: "info",
      service: "web",
      component: "rum",
      msg: "web.rum",
      ts: expect.any(Number),
      trace_id: PAGE_LOAD_ID,
      page_load_id: PAGE_LOAD_ID,
      request_id: "rumreq01",
      seq: 1,
      reason: "hidden",
      path: "/",
      navigation_type: "reload",
      region: "test-region",
      auth_cleared_ms: 0,
      sidebar_populated_ms: 100,
      composer_ready_ms: 200,
      picker_ready_ms: 600_000,
      cls: 0,
      cls_rating: "good",
      fcp_ms: 123.5,
      fcp_rating: "good",
      inp_ms: 250,
      inp_rating: "needs-improvement",
      lcp_ms: 4500,
      lcp_rating: "poor",
      ttfb_ms: 42.5,
      ttfb_rating: "good",
    });
  });

  it("accepts JSON and omits absent optional log fields", async () => {
    vi.stubEnv("VERCEL_REGION", undefined);

    const response = await POST(beacon(undefined, { "Content-Type": "application/json" }));

    expect(response.status).toBe(204);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
      level: "info",
      service: "web",
      component: "rum",
      msg: "web.rum",
      ts: expect.any(Number),
      trace_id: PAGE_LOAD_ID,
      page_load_id: PAGE_LOAD_ID,
      request_id: "rumreq01",
      seq: 1,
      reason: "hidden",
      path: "/",
    });
  });

  it.each([
    ["navigate", "timer"],
    ["reload", "hidden"],
    ["back_forward", "pagehide"],
    ["prerender", "timer"],
  ])("accepts navigation type %s and reason %s", async (navigationType, reason) => {
    const response = await POST(
      beacon(JSON.stringify({ ...payload, seq: 50, navigationType, reason }))
    );

    expect(response.status).toBe(204);
  });

  it.each(["/", "/sessions/123", "/a%20b/%E2%9C%93", `/${"a".repeat(255)}`])(
    "accepts pathname %s",
    async (path) => {
      const response = await POST(beacon(JSON.stringify({ ...payload, path })));

      expect(response.status).toBe(204);
    }
  );

  it("accepts exactly 8 KiB and ten vitals with 64-character ids", async () => {
    const body = JSON.stringify({
      ...payload,
      vitals: Array.from({ length: 10 }, () => ({
        name: "CLS",
        value: 0,
        rating: "good",
        id: "a".repeat(64),
      })),
    });
    const paddedBody = body.padEnd(8192, " ");

    const response = await POST(beacon(paddedBody, { "Content-Length": "8192" }));

    expect(response.status).toBe(204);
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  describe("rejections", () => {
    afterEach(() => {
      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });

    it.each([undefined, "https://foreign.example.com", "null", "not a URL"])(
      "rejects Origin %s",
      async (origin) => {
        const request = beacon();
        if (origin === undefined) request.headers.delete("origin");
        else request.headers.set("origin", origin);

        const response = await POST(request);

        expect(response.status).toBe(403);
        expect(request.bodyUsed).toBe(false);
      }
    );

    it("rejects oversized Content-Length before reading the body", async () => {
      const request = beacon(undefined, { "Content-Length": "8193" });

      const response = await POST(request);

      expect(response.status).toBe(413);
      expect(request.bodyUsed).toBe(false);
    });

    it.each([undefined, "1"])(
      "caps streamed bytes even when Content-Length is %s",
      async (contentLength) => {
        const cancel = vi.fn();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4096));
            controller.enqueue(new Uint8Array(4097));
          },
          cancel,
        });
        const request = new NextRequest("https://app.example.com/api/rum", {
          method: "POST",
          headers: {
            Origin: "https://app.example.com",
            ...(contentLength === undefined ? {} : { "Content-Length": contentLength }),
          },
          body: stream,
        });

        const response = await POST(request);

        expect(response.status).toBe(413);
        expect(cancel).toHaveBeenCalledTimes(1);
      }
    );

    it("caps UTF-8 bytes rather than string length", async () => {
      const body = JSON.stringify({ ...payload, extra: "\u00e9".repeat(4096) });
      expect(body.length).toBeLessThan(8192);

      const response = await POST(beacon(body));

      expect(response.status).toBe(413);
    });

    it.each(["", "not JSON", "{", "null", "[]", "42"])("rejects body %s", async (body) => {
      const response = await POST(beacon(body));

      expect(response.status).toBe(400);
    });

    it.each([
      { v: 2 },
      { v: undefined },
      { pageLoadId: "trace-id" },
      { pageLoadId: "550e8400-e29b-41d4-a716-44665544000z" },
      { pageLoadId: undefined },
      { seq: 0 },
      { seq: 51 },
      { seq: 1.5 },
      { seq: "1" },
      { seq: undefined },
      { reason: "unload" },
      { reason: undefined },
      { path: undefined },
      { navigationType: "push" },
      { navigationType: null },
      { unknown: "field" },
      { milestones: { unknown: 1 } },
      { milestones: { auth_cleared: -1 } },
      { milestones: { sidebar_populated: 600_001 } },
      { milestones: { composer_ready: 1.5 } },
      { milestones: { picker_ready: "1" } },
      { milestones: null },
      {
        vitals: Array.from({ length: 11 }, () => ({
          name: "CLS",
          value: 0,
          rating: "good",
          id: "a",
        })),
      },
      { vitals: [{ name: "FID", value: 1, rating: "good", id: "a" }] },
      { vitals: [{ name: "CLS", value: -1, rating: "good", id: "a" }] },
      { vitals: [{ name: "CLS", value: "1", rating: "good", id: "a" }] },
      { vitals: [{ name: "CLS", value: 1, rating: "unknown", id: "a" }] },
      { vitals: [{ name: "CLS", value: 1, rating: "good", id: "a".repeat(65) }] },
      { vitals: [{ name: "CLS", value: 1, rating: "good" }] },
      { vitals: [{ name: "CLS", value: 1, rating: "good", id: "a", extra: 1 }] },
      { vitals: null },
    ])("rejects invalid payload patch %j", async (patch) => {
      const response = await POST(beacon(JSON.stringify({ ...payload, ...patch })));

      expect(response.status).toBe(400);
    });

    it("rejects non-finite vital values", async () => {
      const body = JSON.stringify({
        ...payload,
        vitals: [{ name: "CLS", value: "NON_FINITE", rating: "good", id: "a" }],
      }).replace('"NON_FINITE"', "1e400");

      const response = await POST(beacon(body));

      expect(response.status).toBe(400);
    });

    it.each([
      "",
      "relative/path",
      "https://foreign.example.com/",
      "//foreign.example.com/",
      "/?secret=value",
      "/#fragment",
      "/sessions?",
      "/sessions#",
      "/sessions\\other",
      "/sessions/../other",
      "/sessions\nother",
      "/unencoded space",
      `/${"a".repeat(256)}`,
    ])("rejects non-pathname %j", async (path) => {
      const response = await POST(beacon(JSON.stringify({ ...payload, path })));

      expect(response.status).toBe(400);
    });
  });
});
