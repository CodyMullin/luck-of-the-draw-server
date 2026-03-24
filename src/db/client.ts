import { PgClient } from "@effect/sql-pg";
import { Redacted } from "effect";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const DatabaseLive = PgClient.layer({
  url: Redacted.make(databaseUrl),
});
