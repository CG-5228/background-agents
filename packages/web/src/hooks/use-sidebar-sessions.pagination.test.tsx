// @vitest-environment jsdom

import { page, snapshot, wrapper, deferred } from "./use-sidebar-sessions.test-fixture";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSidebarSessions } from "./use-sidebar-sessions";
import { useSWRConfig } from "swr";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { updateSessionScope } from "@/lib/session-scope";
import type {
  SessionInboxPage,
  SessionInboxSnapshot,
} from "@open-inspect/shared/types/session-inbox";

describe("useSidebarSessions pagination", () => {
  it("loads additional pages from the category cursor endpoint", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? page(["attention-page-2"])
        : snapshot({ needs_attention: page(["attention"], "next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.sectionPagination.needsAttention.loadMore());

    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual([
        "attention",
        "attention-page-2",
      ])
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/sessions/inbox?category=needs_attention&cursor=next"
    );
  });

  it("keeps additional pages across unchanged and changed coherent head refreshes", async () => {
    let snapshotRequest = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) return page(["old-page-2"]);
      snapshotRequest += 1;
      return snapshot({
        needs_attention: page([snapshotRequest < 3 ? "old-first" : "new-first"], "next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["old-first", "old-page-2"])
    );

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["new-first", "old-page-2"])
    );
  });

  it("accepts an in-flight pagination response after a same-filter head refresh", async () => {
    const pendingPage = deferred<SessionInboxPage>();
    let snapshotRequest = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) return pendingPage.promise;
      snapshotRequest += 1;
      return snapshot({
        needs_attention: page([snapshotRequest === 1 ? "old-first" : "new-first"], "next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.sectionPagination.needsAttention.loadingMore).toBe(true)
    );

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["new-first"])
    );

    await act(async () => pendingPage.resolve(page(["page-2"])));

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["new-first", "page-2"]);
  });

  it("does not refetch loaded pages when the head refreshes", async () => {
    let headRequests = 0;
    let paginationRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) {
        paginationRequests += 1;
        return page(["page-2"]);
      }
      headRequests += 1;
      return snapshot({ needs_attention: page([`head-${headRequests}`], "next") });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() => expect(result.current.needsAttention[0]?.id).toBe("head-2"));

    expect(headRequests).toBe(2);
    expect(paginationRequests).toBe(1);
  });

  it.each([
    { path: "/api/sessions/s1/visibility" as const, method: "PUT" as const },
    { path: "/api/sessions/s1/collaborators/user" as const, method: "DELETE" as const },
  ])("clears all retained pages before lists refresh after $path", async ({ path, method }) => {
    const refreshedSnapshot = deferred<SessionInboxSnapshot>();
    let scopeChanged = false;
    const head = snapshot({
      needs_attention: page(["attention"], "next"),
      in_progress: page(["running"], "next"),
      finished: page(["finished"], "next"),
    });
    const fetcher = vi.fn(async (key: string) => {
      const category = new URLSearchParams(key.split("?")[1]).get("category");
      if (category) return page([`${category}-${scopeChanged ? "visible" : "hidden"}`]);
      return scopeChanged ? refreshedSnapshot.promise : head;
    });
    vi.mocked(browserApiFetch).mockImplementation(async () => {
      scopeChanged = true;
      return new Response(null, { status: 204 });
    });
    const { result } = renderHook(
      () => {
        const sidebar = useSidebarSessions();
        const config = useSWRConfig();
        return {
          ...sidebar,
          updateScope: () => updateSessionScope(path, { method }, async () => {}, config),
        };
      },
      { wrapper: wrapper(fetcher) }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      for (const pagination of Object.values(result.current.sectionPagination)) {
        pagination.loadMore();
      }
    });
    await waitFor(() => {
      expect(result.current.needsAttention).toHaveLength(2);
      expect(result.current.inProgress).toHaveLength(2);
      expect(result.current.finished).toHaveLength(2);
    });

    let update!: Promise<void>;
    act(() => {
      update = result.current.updateScope();
    });
    await waitFor(() => {
      expect(result.current.needsAttention).toEqual([]);
      expect(result.current.inProgress).toEqual([]);
      expect(result.current.finished).toEqual([]);
    });
    await act(async () => {
      refreshedSnapshot.resolve(head);
      await update;
    });

    act(() => {
      for (const pagination of Object.values(result.current.sectionPagination)) {
        pagination.loadMore();
      }
    });
    await waitFor(() => {
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual([
        "attention",
        "needs_attention-visible",
      ]);
      expect(result.current.inProgress.map(({ id }) => id)).toEqual([
        "running",
        "in_progress-visible",
      ]);
      expect(result.current.finished.map(({ id }) => id)).toEqual(["finished", "finished-visible"]);
    });
  });

  it("discards old pagination responses after scope changes even when new loads reuse the cursor", async () => {
    const oldPagesReady = deferred<void>();
    const newPagesReady = deferred<void>();
    let scopeChanged = false;
    const fetcher = vi.fn(async (key: string) => {
      const category = new URLSearchParams(key.split("?")[1]).get("category");
      if (!category) {
        return snapshot({
          needs_attention: page(["attention"], "next"),
          in_progress: page(["running"], "next"),
          finished: page(["finished"], "next"),
        });
      }
      const oldScope = !scopeChanged;
      await (oldScope ? oldPagesReady.promise : newPagesReady.promise);
      return page([`${category}-${oldScope ? "hidden" : "visible"}`]);
    });
    vi.mocked(browserApiFetch).mockImplementation(async () => {
      scopeChanged = true;
      return Response.json({ ok: true });
    });
    const { result } = renderHook(
      () => {
        const sidebar = useSidebarSessions();
        const config = useSWRConfig();
        return {
          ...sidebar,
          updateScope: () =>
            updateSessionScope(
              "/api/sessions/s1/visibility",
              { method: "PUT" },
              async () => {},
              config
            ),
        };
      },
      { wrapper: wrapper(fetcher) }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      for (const pagination of Object.values(result.current.sectionPagination)) {
        pagination.loadMore();
      }
    });
    await waitFor(() => {
      for (const pagination of Object.values(result.current.sectionPagination)) {
        expect(pagination.loadingMore).toBe(true);
      }
    });

    let update!: Promise<void>;
    act(() => {
      update = result.current.updateScope();
    });
    await waitFor(() => {
      expect(fetcher.mock.calls.filter(([key]) => !key.includes("category="))).toHaveLength(2);
      for (const pagination of Object.values(result.current.sectionPagination)) {
        expect(pagination.loadingMore).toBe(false);
      }
    });
    act(() => {
      for (const pagination of Object.values(result.current.sectionPagination)) {
        pagination.loadMore();
      }
    });
    await waitFor(() => {
      for (const pagination of Object.values(result.current.sectionPagination)) {
        expect(pagination.loadingMore).toBe(true);
      }
    });

    await act(async () => oldPagesReady.resolve());
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"]);
    expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running"]);
    expect(result.current.finished.map(({ id }) => id)).toEqual(["finished"]);

    await act(async () => {
      newPagesReady.resolve();
      await update;
    });
    await waitFor(() => {
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual([
        "attention",
        "needs_attention-visible",
      ]);
      expect(result.current.inProgress.map(({ id }) => id)).toEqual([
        "running",
        "in_progress-visible",
      ]);
      expect(result.current.finished.map(({ id }) => id)).toEqual(["finished", "finished-visible"]);
    });
  });

  it("removes a canonical root from every retained category tail", async () => {
    let headRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=needs_attention")) return page(["moved", "tail-only"]);
      headRequests += 1;
      return snapshot({
        needs_attention: page(["attention"], "next"),
        in_progress: page(
          headRequests === 1 ? ["running"] : headRequests === 2 ? ["moved"] : ["running-new"]
        ),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toContain("moved")
    );

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() => expect(result.current.inProgress.map(({ id }) => id)).toEqual(["moved"]));

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention", "tail-only"]);
    expect(
      [
        ...result.current.needsAttention,
        ...result.current.inProgress,
        ...result.current.finished,
      ].filter(({ id }) => id === "moved")
    ).toHaveLength(1);

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() =>
      expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running-new"])
    );
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention", "tail-only"]);
  });

  it("resets loaded pages when the Mine filter changes", async () => {
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) return page(["all-page-2"]);
      return snapshot({
        needs_attention: page([key.includes("mine=true") ? "mine-first" : "all-first"], "next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));

    act(() => result.current.setSessionCreatorFilter("mine"));

    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["mine-first"])
    );
  });

  it("discards an in-flight pagination response when the Mine filter changes", async () => {
    const pendingPage = deferred<SessionInboxPage>();
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) return pendingPage.promise;
      return snapshot({
        needs_attention: page([key.includes("mine=true") ? "mine-first" : "all-first"], "next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.sectionPagination.needsAttention.loadingMore).toBe(true)
    );

    act(() => result.current.setSessionCreatorFilter("mine"));
    await waitFor(() => expect(result.current.needsAttention[0]?.id).toBe("mine-first"));
    await act(async () => pendingPage.resolve(page(["all-page-2"])));

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["mine-first"]);
  });

  it("renders a cross-category tail root only in its newest loaded page", async () => {
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=needs_attention")) return page(["duplicate", "attention-tail"]);
      if (key.includes("category=finished")) return page(["duplicate", "finished-tail"]);
      return snapshot({
        needs_attention: page(["attention"], "attention-next"),
        finished: page(["finished"], "finished-next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toContain("duplicate")
    );

    act(() => result.current.sectionPagination.finished.loadMore());
    await waitFor(() =>
      expect(result.current.finished.map(({ id }) => id)).toContain("finished-tail")
    );

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual([
      "attention",
      "attention-tail",
    ]);
    expect(result.current.finished.map(({ id }) => id)).toEqual([
      "finished",
      "duplicate",
      "finished-tail",
    ]);
  });

  it("retries a failed pagination request", async () => {
    let paginationRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (!key.includes("category=")) {
        return snapshot({ needs_attention: page(["attention"], "next") });
      }
      paginationRequests += 1;
      if (paginationRequests === 1) throw new Error("pagination failed");
      return page(["recovered-page-2"]);
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.sessionsError).toEqual(new Error("pagination failed"))
    );
    await act(async () => result.current.sectionPagination.needsAttention.retry());

    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual([
        "attention",
        "recovered-page-2",
      ])
    );
    expect(paginationRequests).toBe(2);
  });

  it("removes an archived session from retained pages", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? page(["tail-a", "tail-b"])
        : snapshot({ needs_attention: page(["attention"], "next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(3));

    await act(async () => result.current.handleSessionArchived("tail-a"));

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention", "tail-b"]);
  });
});
