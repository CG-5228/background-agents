// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RepositoryHomeProvider } from "@/hooks/use-repository-home";
import { buildSessionHref } from "@/lib/session-list";
import { RepositoryHomeLink, useRepositoryHomeRouter } from "./repository-home-navigation";

const mocks = vi.hoisted(() => ({ query: "", router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams(mocks.query),
}));

afterEach(() => {
  cleanup();
  mocks.query = "";
  vi.clearAllMocks();
});

it.each([false, true])("applies home scope at the link boundary: scoped=%s", (scoped) => {
  mocks.query = scoped ? "homeRepo=group%2Fsubgroup%2Fsite" : "";
  const destination = buildSessionHref({
    id: "session-1",
    title: "Inspect changes",
    repoOwner: "acme",
    repoName: "api",
  });
  expect(destination).not.toContain("homeRepo");
  render(
    <RepositoryHomeProvider>
      <RepositoryHomeLink href={`${destination}#changes`}>Open session</RepositoryHomeLink>
    </RepositoryHomeProvider>
  );
  const url = new URL(
    screen.getByRole("link", { name: "Open session" }).getAttribute("href")!,
    "https://app.test"
  );
  expect(url.searchParams.get("homeRepo")).toBe(scoped ? "group/subgroup/site" : null);
  expect(url.searchParams.get("repoName")).toBe("api");
  expect(url.searchParams.get("title")).toBe("Inspect changes");
  expect(url.hash).toBe("#changes");
});

it.each([false, true])(
  "uses the same scope for push and replace and forwards options: scoped=%s",
  (scoped) => {
    mocks.query = scoped ? "homeRepo=acme%2Fsite" : "";
    const { result } = renderHook(useRepositoryHomeRouter, { wrapper: RepositoryHomeProvider });
    result.current.push("/");
    expect(mocks.router.push).toHaveBeenCalledWith(scoped ? "/?homeRepo=acme%2Fsite" : "/");
    result.current.replace("/sessions?q=landing#results", { scroll: false });
    expect(mocks.router.replace).toHaveBeenCalledWith(
      scoped ? "/sessions?q=landing&homeRepo=acme%2Fsite#results" : "/sessions?q=landing#results",
      { scroll: false }
    );
  }
);

it("replaces an existing home parameter instead of accumulating scopes", () => {
  mocks.query = "homeRepo=acme%2Fsite";
  const { result } = renderHook(useRepositoryHomeRouter, { wrapper: RepositoryHomeProvider });
  result.current.push("/session/child?homeRepo=acme%2Fold");
  expect(mocks.router.push).toHaveBeenCalledWith("/session/child?homeRepo=acme%2Fsite");
});
