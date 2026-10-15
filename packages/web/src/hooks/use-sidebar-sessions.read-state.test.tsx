// @vitest-environment jsdom

import {
  teamContext,
  item,
  unreadItem,
  page,
  snapshot,
  wrapper,
} from "./use-sidebar-sessions.test-fixture";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSidebarSessions } from "./use-sidebar-sessions";
import { reconcileSessionReadState } from "@/lib/session-read-state";
import { browserApiFetch } from "@/lib/browser-api-fetch";

describe("useSidebarSessions read state", () => {
  it("counts every unread session in attention, not just hierarchy roots", async () => {
    const parent = unreadItem("parent");
    const child = { ...unreadItem("child").rootSession, parentSessionId: "parent" };
    const readChild = { ...item("read-child").rootSession, parentSessionId: "parent" };
    // An already-read root whose two descendants are unread.
    const readRoot = item("read-root");
    const unreadDescendants = ["first", "second"].map((id) => ({
      ...unreadItem(id).rootSession,
      parentSessionId: "read-root",
    }));
    const fetcher = vi.fn(async () =>
      snapshot({
        needs_attention: {
          items: [
            { ...parent, descendantSessions: [child, readChild] },
            { ...readRoot, descendantSessions: unreadDescendants },
          ],
          hasMore: false,
          nextCursor: null,
        },
      })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.needsAttention).toHaveLength(2);
    expect(result.current.attentionUnreadCount).toBe(4);
  });

  it("marks the filtered inbox read, then drops retained pages and refetches the head", async () => {
    teamContext.activeTeamId = "team_alpha";
    let markedRead = false;
    vi.mocked(browserApiFetch).mockImplementation(async () => {
      markedRead = true;
      return Response.json({ markedCount: 2 });
    });
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? { items: [unreadItem("tail-unread")], hasMore: false, nextCursor: null }
        : snapshot({
            needs_attention: markedRead ? page([]) : page(["attention"], "next"),
            finished: page(markedRead ? ["attention", "tail-unread"] : ["finished"]),
          })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));

    await act(async () => {
      await result.current.handleMarkAllAttentionRead();
    });

    expect(browserApiFetch).toHaveBeenCalledWith("/api/sessions/inbox/read-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamIds: ["team_alpha"], mine: false }),
    });
    await waitFor(() => expect(result.current.needsAttention).toEqual([]));
    expect(result.current.finished.map(({ id }) => id)).toEqual(["attention", "tail-unread"]);
  });

  it("reconciles read state on retained pages when a session is marked read", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? {
            items: [unreadItem("tail-unread"), unreadItem("tail-other")],
            hasMore: false,
            nextCursor: null,
          }
        : snapshot({ needs_attention: page(["attention"], "next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(3));

    await act(async () => result.current.handleMarkLatestMessageRead("tail-unread"));

    // The freshly read hierarchy leaves the retained attention page; the still
    // unread one stays with its read state intact.
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention", "tail-other"]);
    const remainingTail = result.current.needsAttention.find(({ id }) => id === "tail-other");
    expect(remainingTail?.readState.unread).toBe(true);
  });

  it("keeps retained pages when an already-read session is acknowledged", async () => {
    let snapshotFetches = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=finished")) return page(["finished-tail-a", "finished-tail-b"]);
      if (key.includes("category=in_progress")) return page(["progress-tail"]);
      snapshotFetches += 1;
      return snapshot({
        in_progress: page(["running"], "progress-next"),
        finished: page(["finished"], "finished-next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.finished.loadMore());
    act(() => result.current.sectionPagination.inProgress.loadMore());
    await waitFor(() => expect(result.current.finished).toHaveLength(3));
    await waitFor(() => expect(result.current.inProgress).toHaveLength(2));
    const fetchesBefore = snapshotFetches;

    // Opening a session acknowledges its terminal message even when it is
    // already read. Nothing changed, so nothing in the sidebar should move.
    await act(() =>
      reconcileSessionReadState({
        sessionId: "finished-tail-b",
        outcome: "already_read",
        latestMessageId: "msg-1",
        version: 1,
        unread: false,
      })
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(result.current.finished.map(({ id }) => id)).toEqual([
      "finished",
      "finished-tail-a",
      "finished-tail-b",
    ]);
    expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running", "progress-tail"]);
    expect(snapshotFetches).toBe(fetchesBefore);
  });

  it("keeps retained pages for a not_latest result", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? page(["finished-tail"])
        : snapshot({ finished: page(["finished"], "finished-next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.finished.loadMore());
    await waitFor(() => expect(result.current.finished).toHaveLength(2));

    await act(() =>
      reconcileSessionReadState({
        sessionId: "finished-tail",
        outcome: "not_latest",
        latestMessageId: "msg-9",
        version: 9,
        unread: true,
      })
    );

    expect(result.current.finished.map(({ id }) => id)).toEqual(["finished", "finished-tail"]);
  });

  it("updates a read tail row in place instead of dropping it", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? { items: [unreadItem("finished-tail")], hasMore: false, nextCursor: null }
        : snapshot({ finished: page(["finished"], "finished-next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.finished.loadMore());
    await waitFor(() => expect(result.current.finished).toHaveLength(2));

    await act(() =>
      reconcileSessionReadState({
        sessionId: "finished-tail",
        outcome: "marked_read",
        latestMessageId: "msg-1",
        version: 1,
        unread: false,
      })
    );

    const tail = result.current.finished.find(({ id }) => id === "finished-tail");
    expect(tail?.readState).toEqual({ latestMessageId: "msg-1", version: 1, unread: false });
  });

  it("resets only the destination chain when an attention tail leaves attention", async () => {
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=needs_attention")) {
        return { items: [unreadItem("moving")], hasMore: false, nextCursor: null };
      }
      if (key.includes("category=in_progress")) return page(["progress-tail"]);
      if (key.includes("category=finished")) return page(["finished-tail"]);
      return snapshot({
        needs_attention: page(["attention"], "attention-next"),
        in_progress: page(["running"], "progress-next"),
        finished: page(["finished"], "finished-next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    act(() => result.current.sectionPagination.inProgress.loadMore());
    act(() => result.current.sectionPagination.finished.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));
    await waitFor(() => expect(result.current.inProgress).toHaveLength(2));
    await waitFor(() => expect(result.current.finished).toHaveLength(2));

    await act(() =>
      reconcileSessionReadState({
        sessionId: "moving",
        outcome: "marked_read",
        latestMessageId: "msg-1",
        version: 1,
        unread: false,
      })
    );

    // "moving" is active, so it heads for in_progress: that chain restarts from
    // the head page. The finished chain is unaffected and keeps its tail.
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"]);
    expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running"]);
    expect(result.current.finished.map(({ id }) => id)).toEqual(["finished", "finished-tail"]);
  });

  it("reconciles retained pages when read state changes outside the sidebar", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? { items: [unreadItem("tail-unread")], hasMore: false, nextCursor: null }
        : snapshot({ needs_attention: page(["attention"], "next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));

    await act(() =>
      reconcileSessionReadState({
        sessionId: "tail-unread",
        outcome: "marked_read",
        latestMessageId: "msg-1",
        version: 1,
        unread: false,
      })
    );

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"]);
  });

  it("resets destination pagination when an attention tail changes category", async () => {
    let sessionRead = false;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=needs_attention")) {
        return { items: [unreadItem("moving")], hasMore: false, nextCursor: null };
      }
      if (key.includes("category=in_progress")) {
        return page([
          key.includes("new-progress-next") ? "new-progress-tail" : "old-progress-tail",
        ]);
      }
      return sessionRead
        ? snapshot({
            needs_attention: page(["attention"]),
            in_progress: page(["moving", "running"], "new-progress-next"),
          })
        : snapshot({
            needs_attention: page(["attention"], "attention-next"),
            in_progress: page(["running"], "progress-next"),
          });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    act(() => result.current.sectionPagination.inProgress.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));
    await waitFor(() => expect(result.current.inProgress).toHaveLength(2));

    sessionRead = true;
    await act(() =>
      reconcileSessionReadState({
        sessionId: "moving",
        outcome: "marked_read",
        latestMessageId: "msg-2",
        version: 2,
        unread: false,
      })
    );

    await waitFor(() =>
      expect(result.current.inProgress.map(({ id }) => id)).toEqual(["moving", "running"])
    );
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"]);

    act(() => result.current.sectionPagination.inProgress.loadMore());
    await waitFor(() =>
      expect(result.current.inProgress.map(({ id }) => id)).toEqual([
        "moving",
        "running",
        "new-progress-tail",
      ])
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/sessions/inbox?category=in_progress&cursor=new-progress-next"
    );
  });

  it("invalidates cached pagination before a remount can restore stale unread state", async () => {
    let sessionRead = false;
    let paginationRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (!key.includes("category=")) {
        return snapshot({ needs_attention: page(["attention"], "next") });
      }
      paginationRequests += 1;
      return sessionRead
        ? { items: [], hasMore: false, nextCursor: null }
        : { items: [unreadItem("tail-unread")], hasMore: false, nextCursor: null };
    });
    const cache = new Map();
    const TestWrapper = wrapper(fetcher, cache);
    const first = renderHook(() => useSidebarSessions(), { wrapper: TestWrapper });
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => first.result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(first.result.current.needsAttention).toHaveLength(2));

    sessionRead = true;
    await act(() =>
      reconcileSessionReadState({
        sessionId: "tail-unread",
        outcome: "marked_read",
        latestMessageId: "msg-1",
        version: 1,
        unread: false,
      })
    );
    first.unmount();

    const second = renderHook(() => useSidebarSessions(), { wrapper: TestWrapper });
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    act(() => second.result.current.sectionPagination.needsAttention.loadMore());

    await waitFor(() => expect(paginationRequests).toBe(2));
    await waitFor(() =>
      expect(second.result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"])
    );
  });
});
