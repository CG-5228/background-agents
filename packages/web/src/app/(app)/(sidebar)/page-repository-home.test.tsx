// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mocks, repo, sessionCreateBody } from "./page.test-fixture";
import { RepositoryHomeProvider } from "@/hooks/use-repository-home";
import Home from "./page";

describe("repository home", () => {
  it("offers a shareable link for the selected repository", () => {
    render(<Home />);
    expect(screen.getByRole("link", { name: "Open repository home" })).toHaveAttribute(
      "href",
      "/?homeRepo=open-inspect%2Fbackground-agents"
    );
  });

  it("launches only the home repository and preserves scope after sending", async () => {
    mocks.homeQuery = "homeRepo=group%2Fsubgroup%2Fwebsite";
    mocks.reposValue = [
      repo,
      {
        ...repo,
        id: 2,
        owner: "group/subgroup",
        name: "website",
        fullName: "group/subgroup/website",
      },
    ];
    render(
      <RepositoryHomeProvider>
        <Home />
      </RepositoryHomeProvider>
    );
    expect(screen.getByRole("heading", { name: "group/subgroup/website" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open repository home" })).toBeNull();
    expect(screen.getByRole("link", { name: "All repositories" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("combobox", { name: /website/i })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("What do you want to build?"), {
      target: { value: "Update the website" },
    });
    await waitFor(() =>
      expect(sessionCreateBody()).toMatchObject({
        repoOwner: "group/subgroup",
        repoName: "website",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() =>
      expect(mocks.routerPush).toHaveBeenCalledWith(
        "/session/session-1?homeRepo=group%2Fsubgroup%2Fwebsite"
      )
    );
  });

  it.each(["acme/missing", "invalid", ""])(
    "blocks unavailable or malformed repository homes: %s",
    (fullName) => {
      mocks.homeQuery = new URLSearchParams({ homeRepo: fullName }).toString();
      render(
        <RepositoryHomeProvider>
          <Home />
        </RepositoryHomeProvider>
      );
      fireEvent.change(screen.getByPlaceholderText("What do you want to build?"), {
        target: { value: "Update the website" },
      });
      expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("home repository is unavailable");
      expect(fetch).not.toHaveBeenCalled();
    }
  );
});
