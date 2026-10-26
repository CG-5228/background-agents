// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidTraceId } from "./request-correlation";
import type * as PageLoadTelemetry from "./page-load-telemetry";

let telemetry: typeof PageLoadTelemetry;
let now = 0;
const mark = vi.fn(() => ({ startTime: now }));
const sendBeacon = vi.fn((_url: string, _body: string) => true);

beforeEach(async () => {
  vi.resetModules();
  window.history.replaceState(null, "", "/?private=value");
  now = 0;
  mark.mockClear();
  sendBeacon.mockReset().mockReturnValue(true);
  vi.stubGlobal("performance", {
    mark,
    now: () => now,
    getEntriesByType: () => [{ type: "reload" }],
  });
  vi.stubGlobal("navigator", { sendBeacon });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  telemetry = await import("./page-load-telemetry");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function payload(call = 0) {
  return JSON.parse(sendBeacon.mock.calls[call][1] as string);
}

describe("page-load telemetry", () => {
  it("mints one valid UUID per hard load and records only the initial pathname", () => {
    expect(telemetry.getPageLoadId()).toBeUndefined();
    telemetry.startPageLoadTelemetry();
    const id = telemetry.getPageLoadId();
    telemetry.startPageLoadTelemetry();
    expect(telemetry.getPageLoadId()).toBe(id);
    expect(isValidTraceId(id)).toBe(true);
    expect(id).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
    telemetry.flushPageLoadTelemetry("timer");
    expect(payload()).toEqual({
      v: 1,
      pageLoadId: id,
      seq: 1,
      reason: "timer",
      path: "/",
      navigationType: "reload",
    });
  });

  it("marks once and rounds timings relative to navigation start", () => {
    telemetry.startPageLoadTelemetry();
    now = 123.6;
    telemetry.markPageLoadMilestone("auth_cleared");
    now = 200;
    telemetry.markPageLoadMilestone("auth_cleared");
    telemetry.flushPageLoadTelemetry("hidden");
    expect(mark).toHaveBeenCalledExactlyOnceWith("oi:auth_cleared");
    expect(payload().milestones).toEqual({ auth_cleared: 124 });
  });

  it.each(["before-start", "path-change", "too-late"])(
    "keeps the performance mark but excludes telemetry %s",
    (scenario) => {
      if (scenario !== "before-start") telemetry.startPageLoadTelemetry();
      if (scenario === "path-change") window.history.replaceState(null, "", "/settings");
      if (scenario === "too-late") now = 60_000;
      telemetry.markPageLoadMilestone("composer_ready");
      telemetry.startPageLoadTelemetry();
      telemetry.flushPageLoadTelemetry("timer");
      expect(mark).toHaveBeenCalledExactlyOnceWith("oi:composer_ready");
      expect(payload()).not.toHaveProperty("milestones");
    }
  );

  it("does not flush before start or resend unchanged data, but sends late vital updates", () => {
    telemetry.flushPageLoadTelemetry("hidden");
    expect(sendBeacon).not.toHaveBeenCalled();
    telemetry.startPageLoadTelemetry();
    const vital = { name: "LCP" as const, value: 250, rating: "good" as const, id: "vital-1" };
    telemetry.recordWebVital({ ...vital, value: 100 });
    telemetry.recordWebVital(vital);
    telemetry.flushPageLoadTelemetry("timer");
    telemetry.flushPageLoadTelemetry("hidden");
    telemetry.flushPageLoadTelemetry("pagehide");
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(payload().vitals).toEqual([vital]);
    telemetry.recordWebVital({ ...vital, value: 300 });
    telemetry.flushPageLoadTelemetry("pagehide");
    expect(payload(1)).toMatchObject({ seq: 2, reason: "pagehide", vitals: [{ value: 300 }] });
  });

  it.each([
    ["soft-navigation", "LCP"],
    ["back-forward-cache", "TTFB"],
  ] as const)(
    "does not replace hard-load vitals with %s %s measurements",
    (navigationType, name) => {
      telemetry.startPageLoadTelemetry();
      const vital = { name, value: 250, rating: "good" as const, id: "hard-vital" };
      telemetry.recordWebVital({ ...vital, navigationType: "reload" });
      window.history.replaceState(null, "", "/settings");
      telemetry.recordWebVital({ ...vital, value: 300, navigationType: "reload" });
      telemetry.recordWebVital({ ...vital, value: 0, id: "other-vital", navigationType });
      telemetry.flushPageLoadTelemetry("hidden");
      expect(payload().vitals).toEqual([{ ...vital, value: 300 }]);
      expect(payload().path).toBe("/");
    }
  );

  it.each(["missing", "false", "throws"])(
    "falls back to keepalive fetch when sendBeacon %s",
    async (mode) => {
      if (mode === "missing") vi.stubGlobal("navigator", {});
      if (mode === "false") sendBeacon.mockReturnValue(false);
      if (mode === "throws")
        sendBeacon.mockImplementation(() => {
          throw new Error("Unavailable");
        });
      telemetry.startPageLoadTelemetry();
      telemetry.flushPageLoadTelemetry("hidden");
      expect(fetch).toHaveBeenCalledWith(
        "/api/rum",
        expect.objectContaining({
          method: "POST",
          keepalive: true,
          body: expect.any(String),
        })
      );
      const init = vi.mocked(fetch).mock.calls[0][1]!;
      expect(JSON.parse(init.body as string).pageLoadId).toBe(telemetry.getPageLoadId());
      expect(new Headers(init.headers).get("x-trace-id")).toBe(telemetry.getPageLoadId());
      await Promise.resolve();
    }
  );

  it.each([403, 500, "network"] as const)(
    "retries an unchanged snapshot after a %s failure",
    async (failure) => {
      sendBeacon.mockReturnValue(false);
      if (failure === "network") vi.mocked(fetch).mockRejectedValueOnce(new Error("Unavailable"));
      else vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: failure }));
      telemetry.startPageLoadTelemetry();
      telemetry.flushPageLoadTelemetry("timer");
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      telemetry.flushPageLoadTelemetry("hidden");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toMatchObject({
        seq: 2,
        reason: "hidden",
      });
    }
  );

  it("does not retry a newer delivered snapshot when an older fallback fails", async () => {
    sendBeacon.mockReturnValueOnce(false);
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((done) => {
        resolve = done;
      })
    );
    telemetry.startPageLoadTelemetry();
    telemetry.flushPageLoadTelemetry("timer");
    telemetry.markPageLoadMilestone("picker_ready");
    telemetry.flushPageLoadTelemetry("hidden");
    resolve(new Response(null, { status: 500 }));
    await new Promise<void>((done) => queueMicrotask(done));
    telemetry.flushPageLoadTelemetry("pagehide");
    expect(sendBeacon).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated reports for long-lived tabs", () => {
    telemetry.startPageLoadTelemetry();
    for (let value = 0; value < 55; value++) {
      telemetry.recordWebVital({ name: "INP", value, rating: "good", id: "inp-1" });
      telemetry.flushPageLoadTelemetry("hidden");
    }
    expect(sendBeacon).toHaveBeenCalledTimes(50);
    expect(payload(49).seq).toBe(50);
  });
});
