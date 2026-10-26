// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReportWebVitals } from "next/web-vitals";
import { flushPageLoadTelemetry, recordWebVital } from "@/lib/page-load-telemetry";
import { PageLoadTelemetry } from "./page-load-telemetry";

vi.mock("next/web-vitals", () => ({ useReportWebVitals: vi.fn() }));
vi.mock("@/lib/page-load-telemetry", () => ({
  flushPageLoadTelemetry: vi.fn(),
  recordWebVital: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PageLoadTelemetry", () => {
  it("uses a stable Web Vitals callback and one timer under StrictMode", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <StrictMode>
        <PageLoadTelemetry />
      </StrictMode>
    );
    rerender(
      <StrictMode>
        <PageLoadTelemetry />
      </StrictMode>
    );
    expect(
      vi.mocked(useReportWebVitals).mock.calls.every(([callback]) => callback === recordWebVital)
    ).toBe(true);
    act(() => vi.advanceTimersByTime(19_999));
    expect(flushPageLoadTelemetry).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(flushPageLoadTelemetry).toHaveBeenCalledExactlyOnceWith("timer");
  });

  it("flushes on hidden and pagehide, then removes listeners and its timer on unmount", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const { unmount } = render(<PageLoadTelemetry />);
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(flushPageLoadTelemetry).not.toHaveBeenCalled();
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(flushPageLoadTelemetry).toHaveBeenCalledWith("hidden");
    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(flushPageLoadTelemetry).toHaveBeenCalledWith("pagehide");
    vi.mocked(flushPageLoadTelemetry).mockClear();
    unmount();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    act(() => vi.advanceTimersByTime(20_000));
    expect(flushPageLoadTelemetry).not.toHaveBeenCalled();
  });
});
