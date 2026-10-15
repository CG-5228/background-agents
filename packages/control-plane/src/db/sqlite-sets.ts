import type { SqlDatabase } from "./sql-database";

/** D1's maximum string size, including a serialized bound JSON parameter. */
export const MAX_SQLITE_JSON_BYTES = 2_000_000;

/**
 * Serialize by UTF-8 bytes rather than row count. Keeping every statement in
 * the caller's batch preserves rollback even when a payload needs splitting.
 */
function jsonBatches(values: readonly unknown[]): string[] {
  const encoder = new TextEncoder();
  const batches: string[] = [];
  let items: string[] = [];
  let bytes = 2; // Array brackets.
  for (const value of values) {
    const item = JSON.stringify(value);
    const itemBytes = encoder.encode(item).byteLength;
    if (itemBytes + 2 > MAX_SQLITE_JSON_BYTES) {
      throw new Error("SQL set row exceeds the JSON parameter byte limit");
    }
    if (bytes + itemBytes + (items.length ? 1 : 0) > MAX_SQLITE_JSON_BYTES) {
      batches.push(`[${items.join(",")}]`);
      items = [];
      bytes = 2;
    }
    bytes += itemBytes + (items.length ? 1 : 0);
    items.push(item);
  }
  if (items.length) batches.push(`[${items.join(",")}]`);
  return batches;
}

/** SQLite-specific capabilities shared by the D1 and node:sqlite adapters. */
export function sqliteSetOperations(db: SqlDatabase): Pick<SqlDatabase, "bulkInsert" | "idList"> {
  return {
    bulkInsert(table, columns, rows) {
      const fields = columns.map((_, index) => `json_extract(value, '$[${index}]')`);
      return jsonBatches(rows).map((json) =>
        db
          .prepare(
            `INSERT INTO ${table} (${columns.join(", ")})
           SELECT ${fields.join(", ")} FROM json_each(?) ORDER BY CAST(key AS INTEGER)`
          )
          .bind(json)
      );
    },
    idList(ids) {
      return jsonBatches(ids).map((json) => ({
        sql: "SELECT value FROM json_each(?)",
        values: [json],
      }));
    },
  };
}
