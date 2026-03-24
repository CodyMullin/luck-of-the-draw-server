import { Effect, Console, Layer } from "effect";
import { PgDrizzle, layer as PgDrizzleLayer } from "@effect/sql-drizzle/Pg";
import { sql } from "drizzle-orm";
import * as schema from "./schema.ts";
import { DatabaseLive } from "./client.ts";

const POSITIONS = [
  "P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH",
] as const;

const POSITION_COLUMNS = {
  P: "g_p",
  C: "g_c",
  "1B": "g_1b",
  "2B": "g_2b",
  "3B": "g_3b",
  SS: "g_ss",
  LF: "g_lf",
  CF: "g_cf",
  RF: "g_rf",
  DH: "g_dh",
} as const;

function parseCsv(content: string): Record<string, string>[] {
  const lines = content.replace(/^\uFEFF/, "").split("\n");
  const headers = lines[0]!.split(",").map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const values = line.split(",");
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = values[j]?.trim() ?? "";
    }
    rows.push(row);
  }
  return rows;
}

const BATCH_SIZE = 1000;

const seed = Effect.gen(function* () {
  const db = yield* PgDrizzle;

  yield* Console.log("Reading CSV files...");

  const peopleRaw = yield* Effect.promise(() => Bun.file("data/People.csv").text());
  const teamsRaw = yield* Effect.promise(() => Bun.file("data/Teams.csv").text());
  const appearancesRaw = yield* Effect.promise(() => Bun.file("data/Appearances.csv").text());

  const peopleCsv = parseCsv(peopleRaw);
  const teamsCsv = parseCsv(teamsRaw);
  const appearancesCsv = parseCsv(appearancesRaw);

  yield* Console.log(
    `Parsed: ${peopleCsv.length} people, ${teamsCsv.length} teams, ${appearancesCsv.length} appearances`
  );

  // Seed people
  yield* Console.log("Seeding people...");
  const peopleRows = peopleCsv.map((row) => ({
    playerID: row["playerID"]!,
    nameFirst: row["nameFirst"] ?? "",
    nameLast: row["nameLast"] ?? "",
    nameGiven: row["nameGiven"] || null,
  }));

  for (let i = 0; i < peopleRows.length; i += BATCH_SIZE) {
    const batch = peopleRows.slice(i, i + BATCH_SIZE);
    yield* Effect.tryPromise(() =>
      db.insert(schema.people).values(batch).onConflictDoNothing()
    );
  }
  yield* Console.log(`  Inserted ${peopleRows.length} people`);

  // Seed teams (one row per year+team)
  yield* Console.log("Seeding teams...");
  const teamRows = teamsCsv
    .filter((row) => row["yearID"] && row["teamID"] && row["name"])
    .map((row) => ({
      yearID: parseInt(row["yearID"]!),
      teamID: row["teamID"]!,
      lgID: row["lgID"] || null,
      name: row["name"]!,
    }));

  for (let i = 0; i < teamRows.length; i += BATCH_SIZE) {
    const batch = teamRows.slice(i, i + BATCH_SIZE);
    yield* Effect.tryPromise(() =>
      db.insert(schema.teams).values(batch).onConflictDoNothing()
    );
  }
  yield* Console.log(`  Inserted ${teamRows.length} teams`);

  // Seed appearances
  yield* Console.log("Seeding appearances...");
  const appearanceRows = appearancesCsv
    .filter((row) => row["yearID"] && row["teamID"] && row["playerID"])
    .map((row) => ({
      yearID: parseInt(row["yearID"]!),
      teamID: row["teamID"]!,
      playerID: row["playerID"]!,
      gAll: parseInt(row["G_all"] || "0"),
      gP: parseInt(row["G_p"] || "0"),
      gC: parseInt(row["G_c"] || "0"),
      g1b: parseInt(row["G_1b"] || "0"),
      g2b: parseInt(row["G_2b"] || "0"),
      g3b: parseInt(row["G_3b"] || "0"),
      gSs: parseInt(row["G_ss"] || "0"),
      gLf: parseInt(row["G_lf"] || "0"),
      gCf: parseInt(row["G_cf"] || "0"),
      gRf: parseInt(row["G_rf"] || "0"),
      gDh: parseInt(row["G_dh"] || "0"),
    }));

  for (let i = 0; i < appearanceRows.length; i += BATCH_SIZE) {
    const batch = appearanceRows.slice(i, i + BATCH_SIZE);
    yield* Effect.tryPromise(() =>
      db.insert(schema.appearances).values(batch).onConflictDoNothing()
    );
  }
  yield* Console.log(`  Inserted ${appearanceRows.length} appearances`);

  // Materialize valid_draws
  yield* Console.log("Materializing valid_draws...");
  yield* Effect.tryPromise(() => db.delete(schema.validDraws));

  for (const pos of POSITIONS) {
    const col = POSITION_COLUMNS[pos];
    yield* Effect.tryPromise(() =>
      db.execute(sql`
        INSERT INTO valid_draws (year_id, team_id, team_name, position)
        SELECT DISTINCT a.year_id, a.team_id, t.name, ${sql.raw(`'${pos}'::field_position`)}
        FROM appearances a
        JOIN teams t ON a.year_id = t.year_id AND a.team_id = t.team_id
        WHERE a.${sql.identifier(col)} > 0
      `)
    );
    yield* Console.log(`  Added valid draws for position ${pos}`);
  }

  const drawCount = yield* Effect.tryPromise(() =>
    db.select({ count: sql<number>`count(*)` }).from(schema.validDraws)
  );
  yield* Console.log(`  Total valid draws: ${drawCount[0]?.count}`);

  yield* Console.log("Seed complete!");
});

const DrizzleLive = PgDrizzleLayer.pipe(Layer.provide(DatabaseLive));

seed.pipe(Effect.provide(DrizzleLive), Effect.runPromise);
