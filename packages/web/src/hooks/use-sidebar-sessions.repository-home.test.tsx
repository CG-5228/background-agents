// @vitest-environment jsdom

import { home, page, snapshot, wrapper } from "./use-sidebar-sessions.test-fixture";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSidebarSessions } from "./use-sidebar-sessions";
import { browserApiFetch } from "@/lib/browser-api-fetch";

describe("useSidebarSessions repository homes", () => {
  it("scopes snapshots, cursor pages and bulk reads to the repository home", async () => {
    home.query = "homeRepo=group%2Fsubgroup%2Fsite";
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=") ? page(["tail"]) : snapshot({ finished: page(["head"], "next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.finished).toHaveLength(1));
    expect(fetcher).toHaveBeenCalledWith(
      "/api/sessions/inbox?repoOwner=group%2Fsubgroup&repoName=site"
    );
    act(() => result.current.sectionPagination.finished.loadMore());
    await waitFor(() => expect(result.current.finished).toHaveLength(2));
    expect(fetcher).toHaveBeenCalledWith(
      "/api/sessions/inbox?category=finished&cursor=next&repoOwner=group%2Fsubgroup&repoName=site"
    );
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ markedCount: 0 }));
    await act(() => result.current.handleMarkAllAttentionRead());
    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/sessions/inbox/read-state",
      expect.objectContaining({
        body: JSON.stringify({ repoOwner: "group/subgroup", repoName: "site", mine: false }),
      })
    );
  });
});
