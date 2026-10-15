// Provider contracts match the repository's REST clients and installed OpenComputer SDK.
// Vercel snapshots have no name: resolve ownership through their named source sandbox.
const REQUEST_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 100;

export function managedNamePattern(policy) {
  // Match Terraform's complete content-hash name, never arbitrary openinspect-* artifacts.
  const prefix = policy.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${prefix}${policy.provider === "daytona" ? "-m[1-9][0-9]*" : ""}-[a-f0-9]{16}$`
  );
}

function required(env, key) {
  if (!env[key]) throw new Error(`${key} is required`);
  return env[key];
}

function timestamp(value) {
  return typeof value === "number" ? value : Date.parse(value);
}

function normalize(snapshot, provider, name = snapshot.name) {
  const state = provider === "daytona" ? snapshot.state : snapshot.status;
  const readyStates = {
    vercel: ["created"],
    daytona: ["active", "inactive"],
    opencomputer: ["ready"],
  };
  const failedStates = {
    vercel: ["failed"],
    daytona: ["error", "build_failed"],
    opencomputer: ["failed"],
  };
  if (typeof snapshot.id !== "string" || typeof name !== "string") {
    throw new Error("Invalid snapshot metadata");
  }
  return {
    id: snapshot.id,
    name,
    ready: readyStates[provider].includes(state),
    terminal: [...readyStates[provider], ...failedStates[provider]].includes(state),
    createdAtMs: timestamp(snapshot.createdAt),
    lastUsedAtMs: snapshot.lastUsedAt == null ? undefined : timestamp(snapshot.lastUsedAt),
  };
}

export function createSnapshotClient(policy, env, fetchFn) {
  const { provider } = policy;
  let baseUrl;
  let headers;
  let scope = {};
  if (provider === "vercel") {
    baseUrl = env.VERCEL_SANDBOX_API_BASE_URL || "https://vercel.com/api";
    headers = { Authorization: `Bearer ${required(env, "VERCEL_TOKEN")}` };
    scope = { project: required(env, "VERCEL_PROJECT_ID") };
    if (env.VERCEL_TEAM_ID) scope.teamId = env.VERCEL_TEAM_ID;
  } else if (provider === "daytona") {
    baseUrl = required(env, "DAYTONA_API_URL");
    headers = { Authorization: `Bearer ${required(env, "DAYTONA_API_KEY")}` };
  } else {
    baseUrl = (env.OPENCOMPUTER_API_URL || "https://app.opencomputer.dev/api").replace(/\/+$/, "");
    if (!baseUrl.endsWith("/api")) baseUrl += "/api";
    headers = { "X-API-Key": required(env, "OPENCOMPUTER_API_KEY") };
  }
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
  ) {
    throw new Error("Provider URL must use HTTPS (HTTP is allowed only on loopback)");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("Invalid provider URL");
  baseUrl = baseUrl.replace(/\/+$/, "");

  async function request(path, query = {}, method = "GET") {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries({ ...scope, ...query })) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    const response = await fetchFn(url, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (method === "DELETE" && response.status === 404) {
      await response.arrayBuffer();
      return;
    }
    if (!response.ok)
      throw new Error(`${provider} ${method} ${path} failed (HTTP ${response.status})`);
    if (method === "GET") return response.json();
    await response.arrayBuffer();
  }

  async function cursorPages(path, key, query = {}) {
    const items = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await request(path, { ...query, limit: PAGE_SIZE, cursor });
      if (
        !Array.isArray(page[key]) ||
        !page.pagination ||
        !(page.pagination.next === null || typeof page.pagination.next === "string")
      ) {
        throw new Error("Invalid cursor pagination response");
      }
      items.push(...page[key]);
      cursor = page.pagination.next;
      if (cursor !== null && (!cursor || cursors.has(cursor)))
        throw new Error("Repeated pagination cursor");
      cursors.add(cursor);
    } while (cursor !== null);
    return items;
  }

  return {
    async list() {
      if (provider === "opencomputer") {
        const snapshots = await request("/snapshots");
        if (!Array.isArray(snapshots)) throw new Error("Invalid snapshot list");
        return snapshots.map((snapshot) => normalize(snapshot, provider));
      }
      if (provider === "daytona") {
        const snapshots = [];
        for (let pageNumber = 1; ; pageNumber++) {
          const page = await request("/snapshots", {
            page: pageNumber,
            limit: PAGE_SIZE,
            sort: "createdAt",
            order: "asc",
          });
          if (
            !Array.isArray(page.items) ||
            page.page !== pageNumber ||
            !Number.isSafeInteger(page.totalPages) ||
            page.totalPages < 0 ||
            (page.totalPages < pageNumber &&
              !(pageNumber === 1 && page.totalPages === 0 && page.items.length === 0))
          ) {
            throw new Error("Invalid Daytona pagination response");
          }
          snapshots.push(...page.items.map((snapshot) => normalize(snapshot, provider)));
          if (pageNumber >= page.totalPages) return snapshots;
        }
      }
      const sandboxes = await cursorPages("/v2/sandboxes", "sandboxes", {
        namePrefix: `${policy.prefix}-`,
      });
      const snapshots = [];
      // Only immutable Terraform base-build names, excluding verification/session sandboxes.
      const pattern = managedNamePattern(policy);
      for (const sandbox of sandboxes) {
        if (!pattern.test(sandbox.name)) continue;
        const items = await cursorPages("/v2/sandboxes/snapshots", "snapshots", {
          name: sandbox.name,
        });
        snapshots.push(...items.map((snapshot) => normalize(snapshot, provider, sandbox.name)));
      }
      return snapshots;
    },
    async delete(snapshot) {
      const reference = provider === "opencomputer" ? snapshot.name : snapshot.id;
      const path = provider === "vercel" ? "/v2/sandboxes/snapshots" : "/snapshots";
      await request(`${path}/${encodeURIComponent(reference)}`, {}, "DELETE");
    },
  };
}
