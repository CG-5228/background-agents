import type { SqlDatabase } from "../db/sql-database";
import { sqliteSetOperations } from "../db/sqlite-sets";

/** Adapt the raw binding without changing statement ownership or batch semantics. */
export function createD1SqlDatabase(db: D1Database): SqlDatabase {
  const database: SqlDatabase = db;
  return {
    prepare: (query) => db.prepare(query),
    batch: (statements) => database.batch(statements),
    ...sqliteSetOperations(db),
  };
}
