import { describe, expect, it, vi } from "vitest";
import { createMockSession } from "../../../sandbox/lifecycle/test-helpers";
import type { MessageRepository } from "../../message-repository";
import type { SandboxStateReader } from "../../sandbox-ports";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SessionStatusService } from "../../session-status-service";
import type { SessionTitleService } from "../../title-service";
import { SessionLifecycleHandler } from "./session-lifecycle.handler";

function createHandler() {
  const beginTransition = vi.fn<SessionStatusService["beginTransition"]>();
  const confirmIndexStatus = vi.fn<SessionStatusService["confirmIndexStatus"]>();
  const preserveForArchive = vi.fn(async () => undefined);
  const handler = new SessionLifecycleHandler(
    { getSession: () => createMockSession() } as SessionCoreRepository,
    {} as SandboxStateReader,
    { getPendingOrProcessingCount: () => 0 } as MessageRepository,
    { beginTransition, confirmIndexStatus } as unknown as SessionStatusService,
    {} as SessionTitleService,
    { cancelSandbox: vi.fn(), preserveForArchive },
    "session-do-id",
    vi.fn(),
    { deleteExpiredDraft: vi.fn(async () => true) }
  );
  return { handler, beginTransition, confirmIndexStatus, preserveForArchive };
}

describe("SessionLifecycleHandler.archive", () => {
  it("archives successfully without participant authorization", async () => {
    const { handler, beginTransition, preserveForArchive } = createHandler();
    beginTransition.mockResolvedValue(true);

    const response = await handler.archive();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "archived", outcome: "archived" });
    expect(beginTransition).toHaveBeenCalledWith("archived");
    expect(preserveForArchive).toHaveBeenCalledOnce();
    expect(beginTransition.mock.invocationCallOrder[0]).toBeLessThan(
      preserveForArchive.mock.invocationCallOrder[0]
    );
  });

  it("does not preserve when the synchronous local transition fails", async () => {
    const { handler, beginTransition, preserveForArchive, confirmIndexStatus } = createHandler();
    beginTransition.mockImplementation(() => {
      throw new Error("local status write failed");
    });

    await expect(handler.archive()).rejects.toThrow("local status write failed");

    expect(preserveForArchive).not.toHaveBeenCalled();
    expect(confirmIndexStatus).not.toHaveBeenCalled();
  });
});

describe("SessionLifecycleHandler.expireDraft", () => {
  function createDraftHandler(
    options: { status?: "created" | "active"; deleteFails?: boolean } = {}
  ) {
    const session = { ...createMockSession(), status: options.status ?? "created" };
    let discarded = false;
    const events: string[] = [];
    const repository = {
      getSession: () => session,
      isSessionDiscarded: () => discarded,
      markSessionDiscarded: vi.fn(() => {
        discarded = true;
        events.push("mark");
      }),
      updateSessionStatus: vi.fn((_id: string, status: string) => {
        session.status = status as typeof session.status;
        events.push(`status:${status}`);
      }),
    };
    const statusService = {
      transition: vi.fn(),
      beginTransition: vi.fn(),
      repairIndexStatus: vi.fn(async () => undefined),
    };
    const cancelSandbox = vi.fn(async () => {
      events.push("cancel");
    });
    let failDelete = options.deleteFails ?? false;
    const deleteExpiredDraft = vi.fn(async () => {
      events.push("delete");
      if (failDelete) throw new Error("D1 unavailable");
      return true;
    });
    const handler = new SessionLifecycleHandler(
      repository as unknown as SessionCoreRepository,
      {} as SandboxStateReader,
      { getPendingOrProcessingCount: () => 0, getMessageCount: () => 0 } as MessageRepository,
      statusService as unknown as SessionStatusService,
      {} as SessionTitleService,
      { cancelSandbox, preserveForArchive: vi.fn() },
      "session-do-id",
      vi.fn(),
      { deleteExpiredDraft }
    );
    return {
      handler,
      events,
      statusService,
      deleteExpiredDraft,
      recover: () => {
        failDelete = false;
      },
    };
  }

  it("commits the discard before any I/O and never projects the archive", async () => {
    const { handler, events, statusService } = createDraftHandler();

    const response = await handler.expireDraft();

    expect(await response.json()).toEqual({ outcome: "discarded", status: "archived" });
    expect(events).toEqual(["mark", "status:archived", "cancel", "delete"]);
    // The index keeps reading `created` until its row is deleted.
    expect(statusService.transition).not.toHaveBeenCalled();
    expect(statusService.beginTransition).not.toHaveBeenCalled();
  });

  it("finishes a discard whose index delete failed on the next call", async () => {
    const { handler, events, deleteExpiredDraft, recover } = createDraftHandler({
      deleteFails: true,
    });

    await expect(handler.expireDraft()).rejects.toThrow("D1 unavailable");
    recover();
    const retried = await handler.expireDraft();

    expect(await retried.json()).toEqual({ outcome: "discarded", status: "archived" });
    expect(deleteExpiredDraft).toHaveBeenCalledTimes(2);
    // The decision was made once; the retry only repeats the cleanup.
    expect(events.filter((event) => event === "mark")).toEqual(["mark"]);
  });

  it("leaves a session that is not a draft alone", async () => {
    const { handler, events, deleteExpiredDraft } = createDraftHandler({ status: "active" });

    const response = await handler.expireDraft();

    expect(await response.json()).toEqual({ outcome: "not_draft", status: "active" });
    expect(events).toEqual([]);
    expect(deleteExpiredDraft).not.toHaveBeenCalled();
  });
});
