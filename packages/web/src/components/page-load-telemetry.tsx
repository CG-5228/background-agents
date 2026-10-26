"use client";

import { useEffect } from "react";
import { useReportWebVitals } from "next/web-vitals";
import { flushPageLoadTelemetry, recordWebVital } from "@/lib/page-load-telemetry";

const FLUSH_DELAY_MS = 20_000;

export function PageLoadTelemetry() {
  useReportWebVitals(recordWebVital);
  useEffect(() => {
    // Let Web Vitals' visibility listeners finish collecting their final values first.
    const onHidden = () => {
      if (document.visibilityState === "hidden") {
        queueMicrotask(() => flushPageLoadTelemetry("hidden"));
      }
    };
    const onPageHide = () => queueMicrotask(() => flushPageLoadTelemetry("pagehide"));
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    const timer = window.setTimeout(() => flushPageLoadTelemetry("timer"), FLUSH_DELAY_MS);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      window.clearTimeout(timer);
    };
  }, []);
  return null;
}
