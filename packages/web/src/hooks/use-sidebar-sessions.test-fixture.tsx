import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type {
  SessionInboxItem,
  SessionInboxPage,
  SessionInboxSnapshot,
} from "@open-inspect/shared/types/session-inbox";
import { RepositoryHomeProvider } from "./use-repository-home";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "github:123", name: "Test User" } } }),
}));

const home = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(home.query) }));

const teamContext = vi.hoisted(() => ({
  activeTeamId: null as string | null,
  scope: undefined as "workspace" | "all" | undefined,
  canListAllTeams: false,
}));
vi.mock("./use-active-team", () => ({ useActiveTeam: () => ({ ...teamContext, loading: false }) }));

vi.mock("@/lib/session-read-state", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    markLatestMessageRead: async (sessionId: string) => ({
      sessionId,
      outcome: "marked_read" as const,
      unread: false,
      latestMessageId: "msg-1",
      version: 1,
    }),
  };
});

function item(id: string) {
  return {
    rootSession: {
      id,
      title: id,
      repoOwner: null,
      repoName: null,
      baseBranch: null,
      status: "active" as const,
      parentSessionId: null,
      spawnSource: "user" as const,
      environmentId: null,
      createdAt: 1,
      updatedAt: 2,
      readState: { latestMessageId: null, version: 0, unread: false as const },
    },
    descendantSessions: [],
  };
}

function unreadItem(id: string): SessionInboxItem {
  const base = item(id);
  return {
    ...base,
    rootSession: {
      ...base.rootSession,
      readState: { latestMessageId: "msg-1", version: 1, unread: true },
    },
  };
}

function page(ids: string[], nextCursor: string | null = null): SessionInboxPage {
  const items = ids.map(item);
  return nextCursor === null
    ? { items, hasMore: false, nextCursor: null }
    : { items, hasMore: true, nextCursor };
}

function snapshot(
  overrides: Partial<SessionInboxSnapshot["categories"]> = {}
): SessionInboxSnapshot {
  return {
    categories: {
      needs_attention: page(["attention"]),
      in_progress: page(["running"]),
      finished: page(["finished"]),
      ...overrides,
    },
  };
}

function wrapper(fetcher: (key: string) => unknown, cache = new Map()) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig
        value={{
          provider: () => cache,
          fetcher,
          dedupingInterval: 0,
          focusThrottleInterval: 0,
        }}
      >
        <RepositoryHomeProvider>{children}</RepositoryHomeProvider>
      </SWRConfig>
    );
  };
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  // Vitest globals are disabled, so Testing Library never registers its own
  // afterEach cleanup — unmount explicitly or the 30s poll leaks across tests.
  cleanup();
  localStorage.clear();
  setVisibility("visible");
  vi.restoreAllMocks();
  vi.useRealTimers();
  home.query = "";
  teamContext.activeTeamId = null;
  teamContext.scope = undefined;
});

export { home, teamContext, item, unreadItem, page, snapshot, wrapper, setVisibility, deferred };
