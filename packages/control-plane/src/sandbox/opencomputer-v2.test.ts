import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../../opencomputer-infra/src/build-template";
import { OpenComputerRestClient } from "./opencomputer-rest-client";
import { OpenComputerSandboxProvider } from "./providers/opencomputer-provider";

const { record } = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("../../../sandbox-images/src/node", () => ({
  packImage: () => ({
    directory: "/unused",
    plan: { buildHash: "a".repeat(64), runtimeEnv: {}, runtimeVersion: "test-runtime" },
    files: [],
  }),
  writeBuildResult: record,
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const config = {
  apiUrl: "https://opencomputer.test/api",
  apiKey: "test-key",
  template: "candidate",
};

describe("OpenComputer v2 routing contract", () => {
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let state: string;
  let nextId: number;
  let endAt: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENINSPECT_REPO_ROOT", "/unused");
    vi.stubEnv("OPENINSPECT_IMAGE_CANDIDATE", "candidate");
    vi.stubEnv("OPENCOMPUTER_API_KEY", config.apiKey);
    vi.stubEnv("OPENCOMPUTER_API_URL", config.apiUrl);
    vi.stubEnv("OPENCOMPUTER_DISABLE_HTTP2", "1");
    vi.stubEnv("OPENCOMPUTER_DISABLE_PREWARM", "1");
    requests.length = 0;
    state = "running";
    nextId = 0;
    endAt = "2032-01-01T00:00:00Z";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        requests.push({ path, method, body });
        // Upstream routes creates by SDK major, rather than by a /v2 URL.
        // Missing/0.x headers select the retired fleet on an unpinned org.
        const version = new Headers(init?.headers).get("x-oc-sdk-version") ?? "0";
        if (method === "POST" && ["/api/snapshots", "/api/sandboxes"].includes(path)) {
          if (Number(version.split(".")[0]) < 1) {
            return json({ code: "v1_retired" }, 410);
          }
        }
        if (path === "/api/snapshots") {
          return method === "GET" ? json([]) : json({ name: "candidate", status: "ready" });
        }
        if (path === "/api/secret-stores") return json({ id: "store-1", name: "test-store" });
        if (path.endsWith("/exec/run-async")) return json({}, 404);
        if (path.endsWith("/exec/run"))
          return json({ exitCode: 0, stdout: "verified", stderr: "" });
        if (path.endsWith("/checkpoints")) {
          return json({ id: "checkpoint-1", sandboxId: "sb-1", status: "ready" });
        }
        if (path.endsWith("/restore")) return json({});
        if (path.endsWith("/hibernate")) {
          state = "hibernated";
          return json({});
        }
        if (path.endsWith("/wake")) {
          state = "running";
          return new Response(null, { status: 204 });
        }
        if (path === "/api/sandboxes" && method === "POST") {
          nextId += 1;
          state = "running";
          return json({ sandboxID: `sb-${nextId}`, status: state, endAt });
        }
        if (path.startsWith("/api/sandboxes/") && method === "GET") {
          return json({ sandboxID: `sb-${nextId}`, status: state, endAt: "2032-01-01T00:00:00Z" });
        }
        if (method === "DELETE") return json({});
        throw new Error(`Unexpected OpenComputer request: ${method} ${path}`);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("builds and verifies a managed template using the installed SDK on the active fleet", async () => {
    // Keep the real SDK: mocking Snapshots would hide a stale dependency that
    // routes the build to v1 before a candidate exists.
    await main();
    expect(record).toHaveBeenCalledWith("candidate");
    expect(requests).toContainEqual(
      expect.objectContaining({ path: "/api/snapshots", method: "POST" })
    );
    expect(requests).toContainEqual(
      expect.objectContaining({
        path: "/api/sandboxes",
        method: "POST",
        body: expect.objectContaining({ snapshot: "candidate" }),
      })
    );
    expect(requests.at(-1)).toMatchObject({ path: "/api/sandboxes/sb-1", method: "DELETE" });
  });

  it("creates, checkpoints, preserves, wakes, restores and destroys through the REST provider", async () => {
    const provider = new OpenComputerSandboxProvider(new OpenComputerRestClient(config), {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "test-secret",
    });
    const launch = {
      sessionId: "test-session",
      sandboxId: "test-sandbox",
      repoOwner: "",
      repoName: "",
      controlPlaneUrl: "http://127.0.0.1:9",
      sandboxAuthToken: "test-token",
      harness: "opencode" as const,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      branch: "main",
    };
    const created = await provider.createSandbox(launch);
    expect(created.lifetime).toMatchObject({ kind: "finite", source: "provider" });
    const checkpoint = await provider.takeSnapshot({
      sessionId: launch.sessionId,
      providerObjectId: created.providerObjectId!,
      reason: "manual",
    });
    expect(checkpoint).toEqual({ success: true, imageId: "checkpoint-1" });
    expect(
      await provider.stopSandbox({
        sessionId: launch.sessionId,
        reason: "manual",
        providerObjectId: created.providerObjectId!,
        intent: "preserve",
      })
    ).toEqual({ success: true });
    expect(
      await provider.resumeSandbox({ ...launch, providerObjectId: created.providerObjectId! })
    ).toMatchObject({ success: true });
    const restored = await provider.restoreFromSnapshot({
      ...launch,
      snapshotImageId: checkpoint.imageId!,
    });
    expect(restored.success).toBe(true);
    expect(
      await provider.stopSandbox({
        sessionId: launch.sessionId,
        reason: "manual",
        providerObjectId: restored.providerObjectId!,
        intent: "destroy",
      })
    ).toEqual({ success: true });
    expect(requests.filter(({ path }) => path.endsWith("/checkpoints"))[0].body).toMatchObject({
      kind: "disk_only",
    });
    const restoreIndex = requests.findIndex(({ path }) =>
      path.endsWith("/checkpoints/checkpoint-1/restore")
    );
    expect(restoreIndex).toBeGreaterThan(0);
    expect(requests.slice(restoreIndex + 1)).toContainEqual(
      expect.objectContaining({ path: "/api/sandboxes/sb-2/exec/run" })
    );
    expect(requests.filter(({ path }) => path.includes("from-checkpoint"))).toEqual([]);
  });

  it("does not publish a candidate when verification did not start on v2", async () => {
    endAt = undefined;
    await expect(main()).rejects.toThrow("OpenComputer verification sandbox omitted endAt");
    expect(record).not.toHaveBeenCalled();
    expect(requests.at(-1)).toMatchObject({ path: "/api/sandboxes/sb-1", method: "DELETE" });
  });
});
