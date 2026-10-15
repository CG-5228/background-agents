// @vitest-environment jsdom

import {
  teamContext,
  page,
  snapshot,
  wrapper,
  setVisibility,
} from "./use-sidebar-sessions.test-fixture";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSidebarSessions } from "./use-sidebar-sessions";

describe("useSidebarSessions refresh and filters", () => {
  it("uses the selected team for snapshot and cursor requests and drops retained pages on switches", async () => {
    teamContext.activeTeamId = "team_alpha";
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? page(["alpha-tail"])
        : snapshot({
            needs_attention: page([key.includes("team_beta") ? "beta" : "alpha"], "next"),
          })
    );
    const { result, rerender } = renderHook(useSidebarSessions, { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.needsAttention[0]?.id).toBe("alpha"));
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/inbox?teamIds%5B%5D=team_alpha");
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));
    expect(fetcher).toHaveBeenCalledWith(
      "/api/sessions/inbox?category=needs_attention&cursor=next&teamIds%5B%5D=team_alpha"
    );
    teamContext.activeTeamId = "team_beta";
    rerender();
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["beta"])
    );
  });

  it.each(["workspace", "all"] as const)(
    "keys %s scope separately from the creator filter",
    async (scope) => {
      teamContext.scope = scope;
      const fetcher = vi.fn(async () => snapshot());
      const { result } = renderHook(useSidebarSessions, { wrapper: wrapper(fetcher) });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(fetcher).toHaveBeenCalledWith(`/api/sessions/inbox?scope=${scope}`);
      act(() => result.current.setSessionCreatorFilter("mine"));
      await waitFor(() =>
        expect(fetcher).toHaveBeenCalledWith(`/api/sessions/inbox?mine=true&scope=${scope}`)
      );
    }
  );

  it("uses exactly one canonical request to supply all three categories", async () => {
    const fetcher = vi.fn(async () => snapshot());
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/inbox");
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"]);
    expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running"]);
    expect(result.current.finished.map(({ id }) => id)).toEqual(["finished"]);
  });

  it("polls only the canonical endpoint every 30 seconds while visible", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_key: string) => snapshot());
    renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([key]) => key === "/api/sessions/inbox")).toBe(true);
  });

  it("does not poll while hidden", async () => {
    setVisibility("hidden");
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => snapshot());
    renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("switches Mine to a separate coherent key", async () => {
    const fetcher = vi.fn(async (key: string) =>
      snapshot({ finished: page([key.includes("mine=true") ? "mine" : "all"]) })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.finished.map(({ id }) => id)).toEqual(["all"]));

    act(() => result.current.setSessionCreatorFilter("mine"));

    await waitFor(() => expect(result.current.finished.map(({ id }) => id)).toEqual(["mine"]));
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/inbox?mine=true");
    expect(fetcher.mock.calls.some(([key]) => key.includes("category="))).toBe(false);
  });
});
