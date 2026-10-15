import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { AutomationStore } from "../../src/db/automation-store";
import {
  claimRetry,
  getDueRetries,
  scheduleInvocationRetries,
} from "../../src/db/automation-retries";
import { Scheduler } from "../../src/scheduler/scheduler";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import {
  continueSession,
  releaseHeldPrompts,
  sweepHeldPrompts,
  type ContinuationPolicy,
  steeringActor,
} from "../../src/scheduler/session-continuity";
import { createLogger } from "../../src/logger";
import * as harnessAdmission from "../../src/harness-admission";
import { createRequestMetrics } from "../../src/db/instrumented-sql-database";
import * as targets from "../../src/automation/session-target";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser } from "./helpers";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import { seedGrant, seedTeam } from "./ownership-test-helpers";
import { makeAutomation, makeChild, makeInvocation } from "./invocation-fixtures";

const context = JSON.stringify({
  instructions: "Original job",
  platformUserId: "user-1",
  participantUserId: "user-1",
});

async function seedPendingRetry() {
  const store = new AutomationStore(env.DB);
  await store.create(makeAutomation({ id: "auto", max_retries: 1 }));
  await store.insertInvocationGuarded({
    invocation: makeInvocation("auto", {
      id: "inv",
      concurrency_key: "thread",
      retry_context: context,
    }),
    children: [makeChild("auto", { id: "first", status: "failed", completed_at: Date.now() })],
    overlapScope: { kind: "automation" },
  });
  await scheduleInvocationRetries(env.DB, "inv");
  return store;
}

function schedulerEnv(
  sessionFetch = vi.fn(
    async (_request: Request) => new Response("Init unavailable", { status: 503 })
  )
) {
  return createCloudflareEnv({
    ...env,
    SESSION: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: sessionFetch })),
    } as unknown as DurableObjectNamespace,
  });
}

async function makeDue() {
  await env.DB.prepare("UPDATE automation_runs SET retry_at = 0 WHERE status = 'retrying'").run();
}

describe("automation retry review regressions (real D1)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("user-1");
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    "pause/resume permanently withdraws sessionless retries (tick during pause: %s)",
    async (tick) => {
      const store = await seedPendingRetry();
      await store.pause("auto");
      if (tick) await getDueRetries(env.DB, Date.now() + 120_000, 25);
      await store.resume("auto", Date.now() + 86400_000);
      await scheduleInvocationRetries(env.DB, "inv");
      expect(await getDueRetries(env.DB, Date.now() + 120_000, 25)).toEqual([]);
      expect(await claimRetry(env.DB, "first", "second", Date.now() + 120_000)).toBeNull();
      expect((await store.getRunById("auto", "first"))?.status).toBe("failed");
    }
  );

  it("disable/re-enable cannot resurrect a withdrawn retry", async () => {
    const store = await seedPendingRetry();
    await store.update("auto", { max_retries: 0 });
    await store.update("auto", { max_retries: 1 });
    await scheduleInvocationRetries(env.DB, "inv");
    expect(await getDueRetries(env.DB, Date.now() + 120_000, 25)).toEqual([]);
  });

  it.each(["repository", "changed environment"])(
    "denies retry sessions without current team grants: %s",
    async (kind) => {
      const store = await seedPendingRetry();
      await seedTeam("team-retry", [["user-1", "lead"]]);
      await env.DB.prepare(
        "UPDATE automations SET owner_team_id = 'team-retry' WHERE id = 'auto'"
      ).run();
      await seedGrant("team-retry", { repo_id: 1, repo_owner: "acme", repo_name: "original" });
      await env.DB.prepare(
        "UPDATE automation_runs SET repo_owner = ?, repo_name = ?, repo_id = ?, environment_id = ? WHERE id = 'first'"
      )
        .bind(
          kind === "repository" ? "acme" : null,
          kind === "repository" ? "revoked" : null,
          kind === "repository" ? 2 : null,
          kind === "repository" ? null : "env_changed"
        )
        .run();
      // Resolve the current target at the boundary: a revoked repository or an environment's new member.
      vi.spyOn(targets, "resolveAutomationSessionTarget").mockResolvedValue({
        repoOwner: "acme",
        repoName: kind === "repository" ? "revoked" : "original",
        repoId: kind === "repository" ? 2 : 1,
        defaultBranch: "main",
        environmentId: kind === "repository" ? null : "env_changed",
        ...(kind === "repository"
          ? {}
          : {
              repositories: [
                { repoOwner: "acme", repoName: "original", repoId: 1, baseBranch: "main" },
                { repoOwner: "acme", repoName: "revoked", repoId: 2, baseBranch: "main" },
              ],
            }),
      });
      if (kind === "repository") {
        await seedGrant("team-retry", { repo_id: 2, repo_owner: "acme", repo_name: "revoked" });
        const grants = new TeamRepositoryGrantStore(env.DB);
        const revoked = (await grants.listDetailsForTeam("team-retry")).find(
          (grant) => grant.repoExternalId === 2
        )!;
        await grants.remove("team-retry", revoked.id);
      }
      await makeDue();
      const sessionFetch = vi.fn(async (_request: Request) => Response.json({ status: "ok" }));
      await new Scheduler(env.DB, schedulerEnv(sessionFetch), { submit() {} }).tick();
      const retry = (await store.getInvocation("auto", "inv"))!.runs.find(
        (run) => run.attempt === 2
      )!;
      expect(retry).toMatchObject({
        status: "unauthorized",
        failureReason: "target_team_missing_grant",
        sessionId: null,
      });
      expect(sessionFetch).not.toHaveBeenCalled();
    }
  );

  it.each(["slack", "webhook"] as const)(
    "holds %s follow-ups during backoff, preserves them through sweeps, and transfers them on claim",
    async (source) => {
      const store = await seedPendingRetry();
      const actor = {
        userId: "user-1",
        authorId: "user-1",
        context: {
          db: env.DB,
          trace_id: "test",
          request_id: "delivery-1",
          metrics: createRequestMetrics(),
          executionCtx: { submit() {} },
        },
      };
      const policy: ContinuationPolicy = {
        source,
        resolveActor: async () => actor,
        buildPrompt: async () => ({
          body: {
            content: "Follow-up",
            source: source === "slack" ? "slack" : "automation",
            authorId: "user-1",
            canonicalUserId: "user-1",
            clientRequestId: "delivery-1",
          },
          ctx: { trace_id: "test", request_id: "delivery-1" },
        }),
      };
      const deps = {
        store,
        db: env.DB,
        env: schedulerEnv(),
        log: createLogger("test"),
        backgroundJobs: { submit() {} },
      };
      const outcome = await continueSession(
        deps,
        (await store.getById("auto"))!,
        "thread",
        Date.now(),
        policy
      );
      expect(outcome).toEqual({ kind: "steered", invocationId: "inv" });
      expect(await store.getHeldPrompts("first")).toHaveLength(1);
      await sweepHeldPrompts(deps, Date.now() + 120_000);
      expect(await store.getHeldPrompts("first")).toHaveLength(1);
      const due = (await store.getRunById("auto", "first"))!.retry_at!;
      expect(await claimRetry(env.DB, "first", "second", due)).not.toBeNull();
      expect(await store.getHeldPrompts("first")).toEqual([]);
      expect(await store.getHeldPrompts("second")).toHaveLength(1);
      await env.DB.prepare(
        "INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('retry-session', 'active', 1, 1)"
      ).run();
      const promptFetch = vi.fn(async (_request: Request) =>
        Response.json({ messageId: "follow-up", status: "queued" })
      );
      const releaseDeps = { ...deps, env: schedulerEnv(promptFetch) };
      await store.claimRunSession("second", "retry-session", due, due + 60_000);
      await store.markRunFirstPromptQueued("second");
      expect(
        await releaseHeldPrompts(releaseDeps, (await store.getRunById("auto", "second"))!)
      ).toBe(true);
      expect(promptFetch).toHaveBeenCalledTimes(1);
      expect(await promptFetch.mock.calls[0]![0].clone().json()).toMatchObject({
        content: "Follow-up",
        clientRequestId: "delivery-1",
      });
      expect(await store.getHeldPrompts("second")).toEqual([]);
    }
  );

  it("keeps a follow-up through a retry claim and a launch racing its prompt construction", async () => {
    const store = await seedPendingRetry();
    const backgroundJobs = { submit() {} };
    const promptFetch = vi.fn(async (_request: Request) =>
      Response.json({ messageId: "follow-up", status: "queued" })
    );
    const deps = {
      store,
      db: env.DB,
      env: schedulerEnv(promptFetch),
      log: createLogger("test"),
      backgroundJobs,
    };
    let builds = 0;
    const policy: ContinuationPolicy = {
      source: "webhook",
      resolveActor: () =>
        steeringActor(
          env.DB,
          backgroundJobs,
          { userId: "user-1", authorId: "user-1" },
          "test",
          "follow-up"
        ),
      buildPrompt: async () => {
        builds++;
        if (builds === 1) {
          const due = (await store.getRunById("auto", "first"))!.retry_at!;
          await claimRetry(env.DB, "first", "second", due);
        }
        if (builds === 2) {
          await env.DB.prepare(
            "INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('retry-session', 'active', ?, ?)"
          )
            .bind(Date.now(), Date.now())
            .run();
          await store.claimRunSession("second", "retry-session", Date.now(), Date.now() + 60_000);
          await store.markRunFirstPromptQueued("second");
        }
        return {
          body: { content: "Follow-up", source: "automation", authorId: "user-1" },
          ctx: { trace_id: "test", request_id: "follow-up" },
        };
      },
    };
    expect(
      await continueSession(deps, (await store.getById("auto"))!, "thread", Date.now(), policy)
    ).toEqual({ kind: "steered", invocationId: "inv" });
    expect(promptFetch).toHaveBeenCalledTimes(1);
    expect(builds).toBe(3);
  });

  it("the bounded finalization scan reaches terminal failures behind pending fan-outs", async () => {
    const store = new AutomationStore(env.DB);
    for (let index = 0; index < 51; index++) {
      const id = `auto-${index}`;
      await store.create(makeAutomation({ id }));
      await store.insertInvocationGuarded({
        invocation: makeInvocation(id, { id: `inv-${index}`, created_at: index + 1 }),
        children: [
          makeChild(id, { status: "failed", completed_at: 1, repo_owner: "acme", repo_name: "a" }),
          ...(index < 50
            ? [makeChild(id, { status: "retrying", repo_owner: "acme", repo_name: "b" })]
            : []),
        ],
        overlapScope: { kind: "automation" },
      });
    }
    expect((await store.getUncountedFailedInvocations(0, 50)).map((row) => row.id)).toEqual([
      "inv-50",
    ]);
  });

  it.each(["provider", "target", "init", "prompt", "callback race"])(
    "publishes terminal retry failure exactly once: %s",
    async (stage) => {
      const store = await seedPendingRetry();
      await env.DB.prepare(
        "INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('old-session', 'active', 1, 1)"
      ).run();
      await env.DB.prepare(
        "UPDATE automation_runs SET session_id = 'old-session' WHERE id = 'first'"
      ).run();
      await env.DB.prepare(
        "UPDATE automation_invocations SET trigger_metadata = ? WHERE id = 'inv'"
      )
        .bind(JSON.stringify({ channel: "C1", messageTs: "100.1" }))
        .run();
      const slackFetch = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok")
      );
      if (stage === "provider")
        vi.spyOn(harnessAdmission, "validateHarnessExecution").mockRejectedValueOnce(
          new Error("Provider unavailable")
        );
      if (stage === "target")
        vi.spyOn(targets, "resolveAutomationSessionTarget").mockRejectedValueOnce(
          new Error("Target unavailable")
        );
      const sessionFetch = vi.fn(async (request: Request) => {
        if (new URL(request.url).pathname === "/internal/init")
          return stage === "init"
            ? new Response("Init unavailable", { status: 503 })
            : Response.json({ status: "ok" });
        if (stage === "callback race") {
          const active = (await store.getActiveRunForAutomation("auto"))!;
          await new Scheduler(env.DB, runtime, { submit() {} }).runComplete({
            automationId: "auto",
            runId: active.id,
            sessionId: active.session_id!,
            messageId: "retry-message",
            success: false,
            error: "Retry execution failed",
          });
        }
        return new Response("Prompt unavailable", { status: 503 });
      });
      const runtime = {
        ...schedulerEnv(sessionFetch),
        SLACK_BOT: { fetch: slackFetch },
        SERVICE_AUTH_SECRET_SLACK_BOT: "secret",
      };
      await makeDue();
      await Promise.all([
        new Scheduler(env.DB, runtime, { submit() {} }).tick(),
        new Scheduler(env.DB, runtime, { submit() {} }).tick(),
      ]);
      const retry = (await store.getInvocation("auto", "inv"))!.runs.find(
        (run) => run.attempt === 2
      )!;
      expect(retry.status).toBe("failed");
      expect(slackFetch).toHaveBeenCalledTimes(1);
      expect(String(slackFetch.mock.calls[0]![0])).toContain("automation-complete");
      const body = JSON.parse(String(slackFetch.mock.calls[0]![1]?.body));
      expect(body).toMatchObject({ success: false, channel: "C1", reactionMessageTs: "100.1" });
      await new Scheduler(env.DB, runtime, { submit() {} }).tick();
      expect(slackFetch).toHaveBeenCalledTimes(1);
    }
  );
});
