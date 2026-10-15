import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheStore } from "@open-inspect/shared/cache-store";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import { ModelProviderAccountBrokerError } from "../auth/model-provider-account-broker";
import fixture from "../../test/fixtures/provider-usage/openai.json";
import { ProviderAccountUsageService, PROVIDER_ACCOUNT_USAGE_TIMEOUT_MS } from "./usage-service";
import { OPENAI_USAGE_URL } from "./openai-usage";

const account: ModelProviderAccount = {
  id: "1".repeat(32),
  provider: "openai",
  displayName: "First",
  externalAccountId: "acct-first",
  status: "active",
  createdBy: null,
  updatedBy: null,
  lastVerifiedAt: null,
  lastUsedAt: null,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
};
function setup() {
  const values = new Map<string, string>();
  const cache: CacheStore = {
    get: vi.fn(async (key: string, type?: "json") => {
      const value = values.get(key) ?? null;
      return type === "json" && value ? JSON.parse(value) : value;
    }) as CacheStore["get"],
    put: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key) => {
      values.delete(key);
    }),
  };
  const broker = {
    getAccess: vi.fn(async (id: string) => ({
      accessToken: `token-${id}`,
      externalAccountId: `acct-${id}`,
      credentialVersion: 1,
      expiresAt: Date.now() + 3600_000,
    })),
  };
  const client = { fetch: vi.fn(async () => Response.json(fixture)) };
  return {
    values,
    cache,
    broker,
    client,
    service: new ProviderAccountUsageService(broker, cache, client),
  };
}
describe("provider usage service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_900_000_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("uses the selected account broker and protocol headers; caches only sanitized data", async () => {
    const { service, broker, client, cache, values } = setup();
    const usage = await service.read(account);
    expect(usage.status).toBe("available");
    expect(broker.getAccess).toHaveBeenCalledWith(account.id, "openai", {
      deadlineAt: Date.now() + PROVIDER_ACCOUNT_USAGE_TIMEOUT_MS,
    });
    expect(client.fetch).toHaveBeenCalledWith(
      OPENAI_USAGE_URL,
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({
          Authorization: `Bearer token-${account.id}`,
          "ChatGPT-Account-Id": `acct-${account.id}`,
        }),
      })
    );
    expect(JSON.stringify([...values.values()])).not.toMatch(/token-|acct-|plan_type/);
    expect(await service.read(account)).toEqual(usage);
    expect(broker.getAccess).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("keeps accounts and reconnect revisions separate", async () => {
    const { service, broker, client } = setup();
    client.fetch
      .mockImplementationOnce(async () => Response.json(fixture))
      .mockImplementationOnce(async () =>
        Response.json({
          rate_limit: {
            ...fixture.rate_limit,
            primary_window: { ...fixture.rate_limit.primary_window, used_percent: 7 },
          },
        })
      );
    await service.read(account);
    const second = { ...account, id: "2".repeat(32) };
    expect(await service.read(second)).toMatchObject({ windows: [{ usedPercent: 7 }] });
    await service.read({ ...account, updatedAt: 2 });
    expect(broker.getAccess.mock.calls.map(([id]) => id)).toEqual([
      account.id,
      second.id,
      account.id,
    ]);
  });

  it.each(["disabled", "reconnect_required"] as const)(
    "checks %s lifecycle before cached results",
    async (status) => {
      const { service, broker } = setup();
      await service.read(account);
      expect(await service.read({ ...account, status })).toEqual({
        status: "unavailable",
        reason: "inactive_account",
      });
      expect(broker.getAccess).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["xai", "anthropic"] as const)(
    "does not access credentials or upstream for unsupported %s",
    async (provider) => {
      const { service, broker, cache, client } = setup();
      expect(await service.read({ ...account, provider })).toEqual({ status: "unsupported" });
      expect(broker.getAccess).not.toHaveBeenCalled();
      expect(client.fetch).not.toHaveBeenCalled();
      expect(cache.get).not.toHaveBeenCalled();
    }
  );

  it("expires cached observations when a window resets", async () => {
    const { service, client } = setup();
    client.fetch.mockImplementation(async () =>
      Response.json({
        rate_limit: {
          ...fixture.rate_limit,
          primary_window: { ...fixture.rate_limit.primary_window, reset_at: Date.now() / 1000 + 1 },
        },
      })
    );
    await service.read(account);
    await vi.advanceTimersByTimeAsync(1001);
    await service.read(account);
    expect(client.fetch).toHaveBeenCalledTimes(2);
  });

  it("expires cached observations after the cache interval", async () => {
    const { service, client } = setup();
    await service.read(account);
    await vi.advanceTimersByTimeAsync(60_001);
    await service.read(account);
    expect(client.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([302, 403, 429, 500])("sanitizes and caches provider failure %s", async (status) => {
    const { service, client } = setup();
    client.fetch.mockImplementation(async () => new Response("provider-secret", { status }));
    expect(await service.read(account)).toEqual({
      status: "unavailable",
      reason: "provider_error",
    });
    await service.read(account);
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to a different account on broker failure", async () => {
    const { service, broker, client } = setup();
    broker.getAccess.mockRejectedValue(
      new ModelProviderAccountBrokerError("reconnect_required", "secret")
    );
    expect(await service.read(account)).toEqual({ status: "unavailable", reason: "credentials" });
    expect(client.fetch).not.toHaveBeenCalled();
    expect(broker.getAccess).toHaveBeenCalledTimes(1);
  });

  it.each(["broker", "fetch", "body", "cache"])(
    "bounds a stalled %s with the single request deadline",
    async (stage) => {
      const { service, broker, client, cache } = setup();
      const stalled = () => new Promise<never>(() => {});
      if (stage === "broker") broker.getAccess.mockImplementation(stalled);
      if (stage === "fetch") client.fetch.mockImplementation(stalled);
      if (stage === "body")
        client.fetch.mockImplementation(
          async () => new Response(new ReadableStream({ start() {} }))
        );
      if (stage === "cache") vi.mocked(cache.get).mockImplementation(stalled);
      const reading = service.read(account);
      await vi.advanceTimersByTimeAsync(PROVIDER_ACCOUNT_USAGE_TIMEOUT_MS);
      expect(await reading).toEqual({ status: "unavailable", reason: "timeout" });
    }
  );

  it.each(["<html>blocked</html>", "{}", "x".repeat(65_537)])(
    "handles malformed/oversized responses without forwarding their bodies",
    async (body) => {
      const { service, client } = setup();
      client.fetch.mockImplementation(async () => new Response(body));
      const usage = await service.read(account);
      expect(usage).toMatchObject({ status: "unavailable" });
      expect(JSON.stringify(usage)).not.toContain(body);
    }
  );

  it("keeps reads usable through cache failures", async () => {
    const { service, cache } = setup();
    vi.mocked(cache.get).mockRejectedValue(new Error("cache unavailable"));
    vi.mocked(cache.put).mockRejectedValue(new Error("cache unavailable"));
    expect(await service.read(account)).toMatchObject({ status: "available" });
  });
});
