import {
  opencodePluginSchema,
  type OpencodePlugin,
  type OpencodePluginInput,
} from "@open-inspect/shared/types/opencode-plugins";
import type { SqlDatabase } from "./sql-database";

interface PluginRow {
  id: string;
  spec: string;
  repo_scope: string | null;
  enabled: number;
}

export class OpencodePluginStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(): Promise<OpencodePlugin[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM opencode_plugins ORDER BY spec")
      .all<PluginRow>();
    return results.map((row) =>
      opencodePluginSchema.parse({
        id: row.id,
        spec: row.spec,
        repoScopes: row.repo_scope === null ? null : JSON.parse(row.repo_scope),
        enabled: row.enabled === 1,
      })
    );
  }

  async create(input: OpencodePluginInput): Promise<OpencodePlugin> {
    const plugin = { ...input, id: crypto.randomUUID() };
    await this.db
      .prepare("INSERT INTO opencode_plugins (id, spec, repo_scope, enabled) VALUES (?, ?, ?, ?)")
      .bind(
        plugin.id,
        plugin.spec,
        input.repoScopes === null ? null : JSON.stringify(input.repoScopes),
        input.enabled ? 1 : 0
      )
      .run();
    return plugin;
  }

  async update(id: string, input: OpencodePluginInput): Promise<OpencodePlugin | null> {
    const result = await this.db
      .prepare("UPDATE opencode_plugins SET spec = ?, repo_scope = ?, enabled = ? WHERE id = ?")
      .bind(
        input.spec,
        input.repoScopes === null ? null : JSON.stringify(input.repoScopes),
        input.enabled ? 1 : 0,
        id
      )
      .run();
    return result.meta.changes > 0 ? { ...input, id } : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM opencode_plugins WHERE id = ?")
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  /** Match any session member; repo-less sessions receive only global plugins. */
  async forSession(
    repositories: readonly { repoOwner: string; repoName: string }[]
  ): Promise<string[]> {
    const names = new Set(
      repositories.map((repo) => `${repo.repoOwner}/${repo.repoName}`.toLowerCase())
    );
    return (await this.list())
      .filter(
        (plugin) =>
          plugin.enabled &&
          (plugin.repoScopes === null || plugin.repoScopes.some((scope) => names.has(scope)))
      )
      .map((plugin) => plugin.spec);
  }
}
