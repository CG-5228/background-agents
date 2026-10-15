import { describe, expect, it, vi } from "vitest";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { buildSessionConfig } from "../sandbox-env";
import {
  createMockSession,
  createMockSandbox,
  createMockStorage,
  createMockProvider,
  createTestLifecycleManager,
  createMockBroadcaster,
  createMockWebSocketManager,
  createMockAlarmScheduler,
  createMockIdGenerator,
  createUnmanagedShutdown,
  createTestConfig,
} from "./test-helpers";

describe("Workspace plugins launch contract", () => {
  it.each(["fresh", "restore"] as const)(
    "resolves the current catalog on %s boot and serializes it",
    async (kind) => {
      const storage = createMockStorage(
        createMockSession(),
        createMockSandbox({
          status: kind === "fresh" ? "pending" : "stopped",
          snapshot_image_id: kind === "restore" ? "image-1" : null,
          snapshot_runtime_version: kind === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
        })
      );
      const provider = createMockProvider();
      const forSession = vi.fn().mockResolvedValue(["@company/audit@1.2.3"]);
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        {
          ...createTestConfig(),
          opencodePluginLookup: { forSession },
        }
      );
      await manager.spawnSandbox();
      const launch =
        kind === "fresh"
          ? vi.mocked(provider.createSandbox).mock.calls[0][0]
          : vi.mocked(provider.restoreFromSnapshot!).mock.calls[0][0];
      expect(forSession).toHaveBeenCalledWith(storage.getSessionRepositories());
      expect(launch.opencodePlugins).toEqual(["@company/audit@1.2.3"]);
      expect(buildSessionConfig(launch).opencode_plugins).toEqual(["@company/audit@1.2.3"]);
    }
  );

  it.each(["claude", "codex"] as const)(
    "does not look up plugins for %s sessions",
    async (harness) => {
      const storage = createMockStorage(
        createMockSession({ harness }),
        createMockSandbox({ status: "pending" })
      );
      const provider = createMockProvider();
      const forSession = vi.fn();
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        {
          ...createTestConfig(),
          opencodePluginLookup: { forSession },
        }
      );
      await manager.spawnSandbox();
      expect(forSession).not.toHaveBeenCalled();
      expect(vi.mocked(provider.createSandbox).mock.calls[0][0].opencodePlugins).toBeUndefined();
    }
  );
});
