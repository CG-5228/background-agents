import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth, seedMessage, queryDO } from "./helpers";
import { runInSessionDO } from "./session-do-access";
import { realLifecycleHarness } from "./sandbox-lifecycle-harness";
import type { SandboxProvider } from "../../src/sandbox/provider";
import { SandboxShutdownRepository } from "../../src/session/sandbox-shutdown-repository";
import { EventRepository } from "../../src/session/event-repository";
import { EXPIRY_CONTINUATION_PROMPT } from "../../src/session/expiry-continuation";

beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

it.each([true, false])(
  "expiry handoff with recent execution progress=%s preserves context or holds manually",
  async (hasProgress) => {
    const { stub } = await initNamedSession(`automatic-expiry-${hasProgress}-${Date.now()}`);
    await seedSandboxAuth(stub, {
      sandboxId: "source",
      authToken: "expiry-token",
      status: "ready",
    });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    const now = Date.now();
    await seedMessage(stub, {
      id: "interrupted",
      authorId,
      content: "Original task",
      source: "web",
      status: "processing",
      createdAt: now - 60_000,
      startedAt: now - 60_000,
    });
    await seedMessage(stub, {
      id: "queued",
      authorId,
      content: "Later user request",
      source: "web",
      status: "pending",
      createdAt: now - 30_000,
    });
    const createSandbox = vi.fn(async () => {
      throw new Error("must restore the saved workspace");
    });
    const restoreFromSnapshot = vi.fn<NonNullable<SandboxProvider["restoreFromSnapshot"]>>(
      async (config) => ({
        success: true,
        sandboxId: config.sandboxId,
        providerObjectId: "restored-object",
        lifetime: {
          kind: "finite",
          expiresAtMs: Date.now() + 7_200_000,
          observedAtMs: Date.now(),
          source: "provider",
        },
      })
    );
    const provider: SandboxProvider = {
      name: "modal",
      capabilities: {
        supportsSandboxTimeout: true,
        supportsSnapshots: true,
        supportsRestore: true,
        supportsExplicitStop: true,
      },
      createSandbox,
      restoreFromSnapshot,
      takeSnapshot: vi.fn(async () => ({
        success: true,
        imageId: "context-snapshot",
        sourceStopped: true,
      })),
    };

    const evidence = await runInSessionDO(stub, async (instance, durableState) => {
      const sql = durableState.storage.sql;
      sql.exec(
        "UPDATE session SET sandbox_settings = ?",
        JSON.stringify({ autoContinueOnExpiry: true })
      );
      sql.exec(
        "UPDATE sandbox SET modal_object_id = ?, runtime_version = ?, last_heartbeat = ?",
        "source-object",
        "v72-runtime",
        now
      );
      const [{ created_at: createdAt }] = sql.exec("SELECT created_at FROM sandbox").toArray() as {
        created_at: number;
      }[];
      const generation = { sandboxId: "source", createdAt };
      const store = new SandboxShutdownRepository(sql);
      store.write({
        phase: "running",
        generation,
        provider: "modal",
        providerObjectId: "source-object",
        lifetimeKind: "finite",
        lifetimeSource: "provider",
        expiresAtMs: now + 600_000,
        drainAtMs: now,
        generationReady: true,
        runtimeReady: true,
        protocolVersion: 1,
        lifecyclePolicy: "confirmed",
      });
      const events = new EventRepository(sql, (callback) =>
        durableState.storage.transactionSync(callback)
      );
      // Heartbeats never qualify as progress. An event from another task does not qualify either.
      events.createEvent({
        id: "heartbeat-proof",
        type: "heartbeat",
        data: "{}",
        messageId: "interrupted",
        createdAt: now,
      });
      events.createEvent({
        id: "other-task",
        type: "tool_call",
        data: "{}",
        messageId: "queued",
        createdAt: now,
      });
      expect(events.hasRecentExecutionProgress("interrupted", now - 600_000, now)).toBe(false);
      if (hasProgress)
        events.createEvent({
          id: "progress-proof",
          type: "token",
          data: "{}",
          messageId: "interrupted",
          createdAt: now,
        });
      const first = realLifecycleHarness(instance, durableState, provider);
      await first.shutdown.handleAlarm();
      first.shutdown.prepared({
        type: "preservation_prepared",
        operationId: store.read()!.operationId!,
        generation,
        executionStopped: true,
        agentSessionId: "saved-conversation",
        sandboxId: "source",
        timestamp: now / 1_000,
      });
      await first.shutdown.handleAlarm();
      await vi.waitFor(() => expect(store.read()?.phase).toBe("saved"));
      const saved = store.read()!;
      expect(saved.phase).toBe("saved");
      const reconstructed = realLifecycleHarness(instance, durableState, provider);
      if (!hasProgress) {
        expect(reconstructed.shutdown.admissionDecision()).toBe("held");
        return { saved, final: store.read() };
      }
      expect(reconstructed.shutdown.pendingContinuationMessageId()).toBe(
        saved.continuation!.messageId
      );
      await reconstructed.manager.spawnSandbox();
      const row = reconstructed.sandbox.getSandbox()!;
      const restoredGeneration = { sandboxId: row.modal_sandbox_id!, createdAt: row.created_at };
      expect(reconstructed.shutdown.admissionDecision()).toBe("held");
      reconstructed.manager.onRuntimeReady(Date.now(), "opencode", 1, "saved-conversation");
      reconstructed.manager.onShutdownGenerationReady({
        type: "sandbox_generation_ready",
        generation: restoredGeneration,
        sandboxId: restoredGeneration.sandboxId,
        timestamp: Date.now() / 1_000,
      });
      expect(reconstructed.shutdown.admissionDecision()).toBe("ready");
      return { saved, final: store.read() };
    });
    const rows = await queryDO<{ id: string; status: string; content: string }>(
      stub,
      "SELECT id, status, content FROM messages"
    );
    expect(rows.find((row) => row.id === "interrupted")?.status).toBe("failed");
    expect(rows.find((row) => row.id === "queued")?.status).toBe("pending");
    expect(rows.filter((row) => row.content === EXPIRY_CONTINUATION_PROMPT)).toHaveLength(
      hasProgress ? 1 : 0
    );
    expect(createSandbox).not.toHaveBeenCalled();
    expect(restoreFromSnapshot).toHaveBeenCalledTimes(hasProgress ? 1 : 0);
    if (hasProgress)
      expect(evidence.final).toMatchObject({
        automaticHandoffs: 1,
        continuation: { contextVerified: true },
      });
  }
);
