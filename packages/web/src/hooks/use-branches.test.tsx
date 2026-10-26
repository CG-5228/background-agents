// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { useBranches } from "./use-branches";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user-1" } } }),
}));

afterEach(cleanup);

function wrapper(fetcher: () => Promise<unknown>) {
  const cache = new Map();
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig value={{ provider: () => cache, fetcher, shouldRetryOnError: false }}>
        {children}
      </SWRConfig>
    );
  };
}

describe("useBranches", () => {
  it("does not settle a late key before data arrives, including an empty branch list", async () => {
    let resolve!: (value: { branches: { name: string }[] }) => void;
    const pending = new Promise<{ branches: { name: string }[] }>((done) => {
      resolve = done;
    });
    const { result, rerender } = renderHook(({ owner }) => useBranches(owner, "repo"), {
      initialProps: { owner: "" },
      wrapper: wrapper(() => pending),
    });
    expect(result.current.settled).toBe(false);
    rerender({ owner: "acme" });
    expect(result.current.settled).toBe(false);
    await act(async () => resolve({ branches: [] }));
    expect(result.current.settled).toBe(true);
    expect(result.current.branches).toEqual([]);
  });

  it("settles after a branch request fails", async () => {
    const { result } = renderHook(() => useBranches("acme", "repo"), {
      wrapper: wrapper(async () => {
        throw new Error("Unavailable");
      }),
    });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.branches).toEqual([]);
  });
});
