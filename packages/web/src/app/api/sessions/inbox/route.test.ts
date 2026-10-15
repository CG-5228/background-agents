import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

it("forwards repository filters alongside inbox pagination and team filters", async () => {
  vi.mocked(controlPlaneUserFetch).mockResolvedValue(
    Response.json({ items: [], hasMore: false, nextCursor: null })
  );
  const response = await GET(
    new NextRequest(
      "https://app.test/api/sessions/inbox?repoOwner=group%2Fsubgroup&repoName=site&category=finished&cursor=next&mine=true&teamIds[]=team_alpha&ignored=true"
    )
  );
  expect(controlPlaneUserFetch).toHaveBeenCalledWith(
    "/sessions/inbox?repoOwner=group%2Fsubgroup&repoName=site&category=finished&cursor=next&mine=true&teamIds%5B%5D=team_alpha"
  );
  expect(response.status).toBe(200);
});
