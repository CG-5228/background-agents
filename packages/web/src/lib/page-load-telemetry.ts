import { browserApiFetch } from "./browser-api-fetch";

export type PageLoadMilestone =
  "auth_cleared" | "sidebar_populated" | "composer_ready" | "picker_ready";
type FlushReason = "timer" | "hidden" | "pagehide";
interface WebVital {
  name: "CLS" | "FCP" | "INP" | "LCP" | "TTFB";
  value: number;
  rating: "good" | "needs-improvement" | "poor";
  id: string;
}

const MILESTONE_WINDOW_MS = 60_000;
const MAX_REPORTS = 50;
const marked = new Set<PageLoadMilestone>();
const milestones: Partial<Record<PageLoadMilestone, number>> = {};
const vitals = new Map<WebVital["name"], WebVital>();
let pageLoad:
  { id: string; path: string; navigationType?: PerformanceNavigationTiming["type"] } | undefined;
let seq = 0;
let lastSent: string | undefined;

export function startPageLoadTelemetry(): void {
  if (pageLoad || typeof window === "undefined") return;
  const navigation = performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  pageLoad = {
    id: crypto.randomUUID(),
    path: window.location.pathname,
    navigationType: navigation?.type,
  };
}

export function getPageLoadId(): string | undefined {
  return pageLoad?.id;
}

export function markPageLoadMilestone(name: PageLoadMilestone): void {
  if (marked.has(name)) return;
  marked.add(name);
  const startTime = performance.mark?.(`oi:${name}`).startTime ?? performance.now();
  if (pageLoad && window.location.pathname === pageLoad.path && startTime < MILESTONE_WINDOW_MS) {
    milestones[name] = Math.round(startTime);
  }
}

export function recordWebVital({ name, value, rating, id }: WebVital): void {
  vitals.set(name, { name, value, rating, id });
}

export function flushPageLoadTelemetry(reason: FlushReason): void {
  if (!pageLoad || seq >= MAX_REPORTS) return;
  const data = {
    v: 1,
    pageLoadId: pageLoad.id,
    path: pageLoad.path.slice(0, 256),
    navigationType: pageLoad.navigationType,
    milestones: Object.keys(milestones).length ? milestones : undefined,
    vitals: vitals.size ? [...vitals.values()] : undefined,
  };
  const snapshot = JSON.stringify(data);
  if (snapshot === lastSent) return;
  const body = JSON.stringify({ ...data, seq: ++seq, reason });
  lastSent = snapshot;
  try {
    if (navigator.sendBeacon?.("/api/rum", body)) return;
  } catch {
    // A browser may refuse beacon delivery; keepalive is still worth trying.
  }
  void browserApiFetch("/api/rum", { method: "POST", keepalive: true, body }).catch(() => {
    // Telemetry must not surface errors to the application. A later flush may retry.
    if (lastSent === snapshot) lastSent = undefined;
  });
}
