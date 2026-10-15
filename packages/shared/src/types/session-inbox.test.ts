import { describe, expect, it } from "vitest";
import { sessionInboxMarkReadRequestSchema } from "./session-inbox";

describe("repository inbox filters", () => {
  it("normalizes nested repository owners", () => {
    expect(
      sessionInboxMarkReadRequestSchema.parse({ repoOwner: " GROUP/Subgroup ", repoName: " SITE " })
    ).toEqual({ repoOwner: "group/subgroup", repoName: "site" });
  });

  it.each([
    { repoOwner: "acme" },
    { repoName: "site" },
    { repoOwner: "", repoName: "site" },
    { repoOwner: "acme", repoName: "x".repeat(257) },
  ])("rejects invalid filters: %j", (filters) => {
    expect(sessionInboxMarkReadRequestSchema.safeParse(filters).success).toBe(false);
  });
});
