import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { browserApiFetch, type BrowserApiPath } from "./browser-api-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserApiFetch", () => {
  it("accepts only same-origin BFF paths at the type boundary", () => {
    expectTypeOf(browserApiFetch).parameter(0).toEqualTypeOf<BrowserApiPath>();
  });

  it("delegates the request and initializer to the browser fetch boundary", async () => {
    const response = new Response(null, { status: 204 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    };

    await expect(browserApiFetch("/api/sessions/session-1/title", init)).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/title", {
      ...init,
      mode: "same-origin",
      credentials: "same-origin",
    });
  });

  it("enforces same-origin browser behavior when the request initializer is omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await browserApiFetch("/api/repos");

    expect(fetchMock).toHaveBeenCalledWith("/api/repos", {
      mode: "same-origin",
      credentials: "same-origin",
    });
  });

  it("adds the page-load trace only after telemetry starts", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { location: { pathname: "/" } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { browserApiFetch: loadFetch } = await import("./browser-api-fetch");
    const { startPageLoadTelemetry, getPageLoadId } = await import("./page-load-telemetry");
    await loadFetch("/api/repos");
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("headers");
    startPageLoadTelemetry();
    await loadFetch("/api/repos");
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("x-trace-id")).toBe(getPageLoadId());
  });

  it.each([
    { "Content-Type": "application/json" },
    [["Content-Type", "application/json"]],
    new Headers({ "Content-Type": "application/json" }),
  ] satisfies HeadersInit[])("preserves caller headers while adding a trace", async (headers) => {
    vi.resetModules();
    vi.stubGlobal("window", { location: { pathname: "/" } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { browserApiFetch: loadFetch } = await import("./browser-api-fetch");
    const { startPageLoadTelemetry, getPageLoadId } = await import("./page-load-telemetry");
    startPageLoadTelemetry();
    await loadFetch("/api/rum", { headers });
    const merged = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(merged.get("content-type")).toBe("application/json");
    expect(merged.get("x-trace-id")).toBe(getPageLoadId());
    expect(new Headers(headers).has("x-trace-id")).toBe(false);
  });

  it("preserves an explicit trace id case-insensitively", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { location: { pathname: "/" } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { browserApiFetch: loadFetch } = await import("./browser-api-fetch");
    const { startPageLoadTelemetry } = await import("./page-load-telemetry");
    startPageLoadTelemetry();
    const headers = { "X-Trace-Id": "caller-trace" };
    await loadFetch("/api/repos", { headers });
    expect(fetchMock.mock.calls[0][1].headers).toBe(headers);
  });
});
