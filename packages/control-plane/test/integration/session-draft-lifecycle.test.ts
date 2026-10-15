import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { SessionIndexStore } from "../../src/db/session-index";
import { ABANDONED_DRAFT_SWEEP_CRON } from "../../src/session/abandoned-draft-sweep";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import { cleanD1Tables } from "./cleanup";
import { queryDO, seedActiveUser, serviceFetch } from "./helpers";

const BASE = "https://test.local";
const STRANGER = "33333333333333333333333333333333";
const TEAMMATE = "44444444444444444444444444444444";

function request(path: string, method = "GET", body?: object, as?: string) {
  return serviceFetch(`${BASE}${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(as ? { as: { userId: as, role: "member" } } : {}),
  });
}

async function createDraft(fields: object = {}): Promise<string> {
  const response = await request("/sessions", "POST", {
    model: "anthropic/claude-sonnet-4-6",
    ...fields,
  });
  expect(response.status).toBe(201);
  return (await response.json<{ sessionId: string }>()).sessionId;
}

async function listedIds(query: string): Promise<string[]> {
  const response = await request(`/sessions?${query}`);
  const body = await response.json<{ sessions: Array<{ id: string }> }>();
  return body.sessions.map((session) => session.id);
}

describe("POST /sessions/:id/discard-draft", () => {
  beforeEach(cleanD1Tables);

  it("deletes an unprompted draft and everything indexed under it", async () => {
    const sessionId = await createDraft();
    // Repository-backed creates need the GitHub App; seed the member row the
    // way create would, to prove dependent rows go with the session.
    await env.DB.prepare(
      `INSERT INTO session_repositories (session_id, position, repo_owner, repo_name, repo_id, base_branch)
       VALUES (?, 0, 'acme', 'web-app', 1, 'main')`
    )
      .bind(sessionId)
      .run();
    const repositories = () =>
      env.DB.prepare("SELECT COUNT(*) AS count FROM session_repositories WHERE session_id = ?")
        .bind(sessionId)
        .first<{ count: number }>();
    expect((await repositories())?.count).toBe(1);

    const response = await request(`/sessions/${sessionId}/discard-draft`, "POST");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "discarded" });
    expect(await new SessionIndexStore(env.DB).get(sessionId)).toBeNull();
    expect((await repositories())?.count).toBe(0);
    expect(await listedIds("excludeStatus=archived")).toEqual([]);
    expect(await listedIds("status=archived")).toEqual([]);
  });

  /**
   * What a discard leaves when it fails after committing: the runtime has
   * decided (discarded, locally archived) but the index row still reads
   * `created`.
   */
  async function halfDiscardedDraft(): Promise<string> {
    const sessionId = await createDraft();
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    await queryDO(
      stub,
      "UPDATE session SET discarded_at = 1, status = 'archived', status_revision = status_revision + 1"
    );
    expect((await new SessionIndexStore(env.DB).get(sessionId))?.status).toBe("created");
    return sessionId;
  }

  it("finishes a discard that failed after the runtime committed it", async () => {
    const sessionId = await halfDiscardedDraft();
    // Nothing can start work in it meanwhile.
    const prompted = await request(`/sessions/${sessionId}/prompt`, "POST", {
      content: "Too late",
      source: "web",
    });
    expect(prompted.status).toBe(409);

    const retried = await request(`/sessions/${sessionId}/discard-draft`, "POST");

    expect(await retried.json()).toEqual({ outcome: "discarded" });
    expect(await new SessionIndexStore(env.DB).get(sessionId)).toBeNull();
  });

  it("lets the sweep finish a discard nobody retried", async () => {
    const sessionId = await halfDiscardedDraft();
    await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .bind(Date.now() - 48 * 60 * 60 * 1000, sessionId)
      .run();

    await worker.scheduled(
      { cron: ABANDONED_DRAFT_SWEEP_CRON } as ScheduledEvent,
      env as unknown as WorkerBindings,
      createExecutionContext()
    );

    expect(await new SessionIndexStore(env.DB).get(sessionId)).toBeNull();
  });

  it("leaves a prompted session untouched, so a discard can never race a send", async () => {
    const sessionId = await createDraft();
    const prompted = await request(`/sessions/${sessionId}/prompt`, "POST", {
      content: "Fix the flaky test",
      source: "web",
    });
    expect(prompted.status).toBe(200);

    const response = await request(`/sessions/${sessionId}/discard-draft`, "POST");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "not_draft" });
    expect((await new SessionIndexStore(env.DB).get(sessionId))?.status).toBe("active");
  });

  it("rejects a prompt that arrives after its draft was discarded", async () => {
    const sessionId = await createDraft();
    await request(`/sessions/${sessionId}/discard-draft`, "POST");

    const late = await request(`/sessions/${sessionId}/prompt`, "POST", {
      content: "Too late",
      source: "web",
    });

    expect(late.status).toBe(404);
  });

  it("answers 404 for an unknown session", async () => {
    const response = await request("/sessions/does-not-exist/discard-draft", "POST");
    expect(response.status).toBe(404);
  });

  it("lets only the draft's creator discard it, even with lifecycle access", async () => {
    await seedActiveUser(TEAMMATE);
    const sessionId = await createDraft();

    const response = await request(
      `/sessions/${sessionId}/discard-draft`,
      "POST",
      undefined,
      TEAMMATE
    );

    expect(response.status).toBe(403);
    expect(await new SessionIndexStore(env.DB).get(sessionId)).not.toBeNull();
    // The draft is still a draft its creator can use.
    const prompted = await request(`/sessions/${sessionId}/prompt`, "POST", {
      content: "Still mine",
      source: "web",
    });
    expect(prompted.status).toBe(200);
  });

  it("authorizes exactly like archive", async () => {
    await seedActiveUser(STRANGER);
    const sessionId = await createDraft({ visibility: "private" });

    const archive = await request(`/sessions/${sessionId}/archive`, "POST", undefined, STRANGER);
    const discard = await request(
      `/sessions/${sessionId}/discard-draft`,
      "POST",
      undefined,
      STRANGER
    );

    expect(archive.ok).toBe(false);
    expect(discard.status).toBe(archive.status);
    expect(await new SessionIndexStore(env.DB).get(sessionId)).not.toBeNull();
  });
});

describe("GET /sessions?excludeDrafts=true", () => {
  beforeEach(cleanD1Tables);

  it("leaves out unprompted drafts but keeps sessions that have work", async () => {
    const draftId = await createDraft();
    const startedId = await createDraft();
    await request(`/sessions/${startedId}/prompt`, "POST", { content: "Go", source: "web" });

    expect((await listedIds("excludeStatus=archived")).sort()).toEqual([draftId, startedId].sort());
    expect(await listedIds("excludeStatus=archived&excludeDrafts=true")).toEqual([startedId]);
  });
});

describe("first prompt into a draft", () => {
  beforeEach(cleanD1Tables);

  async function sessionModel(sessionId: string) {
    const response = await request(`/sessions/${sessionId}`);
    const snapshot = await response.json<{
      session: { model: string; reasoningEffort?: string | null };
    }>();
    return snapshot.session.model;
  }

  async function indexedModel(sessionId: string) {
    // The index projection is background work.
    for (let attempt = 0; attempt < 20; attempt++) {
      const row = await new SessionIndexStore(env.DB).get(sessionId);
      if (row?.model !== "anthropic/claude-sonnet-4-6") return row?.model;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return (await new SessionIndexStore(env.DB).get(sessionId))?.model;
  }

  it("adopts the model the prompt was sent with, and later prompts leave it alone", async () => {
    const sessionId = await createDraft();

    await request(`/sessions/${sessionId}/prompt`, "POST", {
      content: "First",
      source: "web",
      model: "anthropic/claude-opus-4-6",
    });
    expect(await sessionModel(sessionId)).toBe("anthropic/claude-opus-4-6");
    expect(await indexedModel(sessionId)).toBe("anthropic/claude-opus-4-6");

    await request(`/sessions/${sessionId}/prompt`, "POST", {
      content: "Follow-up",
      source: "web",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(await sessionModel(sessionId)).toBe("anthropic/claude-opus-4-6");
  });

  it("keeps the draft's reasoning effort when the first prompt names a model but no effort", async () => {
    const sessionId = await createDraft({ reasoningEffort: "high" });

    await request(`/sessions/${sessionId}/prompt`, "POST", {
      content: "First",
      source: "web",
      model: "anthropic/claude-opus-4-6",
    });

    const response = await request(`/sessions/${sessionId}`);
    const snapshot = await response.json<{
      session: { model: string; reasoningEffort?: string };
    }>();
    expect(snapshot.session).toMatchObject({
      model: "anthropic/claude-opus-4-6",
      reasoningEffort: "high",
    });
  });

  it("keeps an inherited effort when the first prompt repeats the model without one", async () => {
    const sessionId = await createDraft({ reasoningEffort: "max" });

    await request(`/sessions/${sessionId}/prompt`, "POST", {
      content: "First",
      source: "web",
      model: "anthropic/claude-sonnet-4-6",
    });

    const response = await request(`/sessions/${sessionId}`);
    const snapshot = await response.json<{
      session: { model: string; reasoningEffort?: string };
    }>();
    expect(snapshot.session).toMatchObject({
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "max",
    });
    expect((await new SessionIndexStore(env.DB).get(sessionId))?.reasoningEffort).toBe("max");
  });

  it("keeps the draft's model when the first prompt names none", async () => {
    const sessionId = await createDraft();
    await request(`/sessions/${sessionId}/prompt`, "POST", { content: "First", source: "web" });
    expect(await sessionModel(sessionId)).toBe("anthropic/claude-sonnet-4-6");
  });
});
