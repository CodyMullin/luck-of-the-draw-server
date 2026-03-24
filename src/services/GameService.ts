import { Context, Effect, Layer } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import { PgDrizzle } from "../db/drizzle.ts";
import * as schema from "../db/schema.ts";
import type { LobbySettings } from "../db/schema.ts";
import { sql, and, eq, gte, lte, inArray } from "drizzle-orm";

type PositionValue = "P" | "C" | "1B" | "2B" | "3B" | "SS" | "LF" | "CF" | "RF" | "DH";

export interface Draw {
  yearID: number;
  teamID: string;
  teamName: string;
  position: string;
}

export interface ValidPlayer {
  playerID: string;
  nameFirst: string;
  nameLast: string;
}

const POSITION_COLUMN_MAP: Record<string, string> = {
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
};

type E = SqlError | import("effect/Cause").UnknownException;

export class GameService extends Context.Tag("GameService")<
  GameService,
  {
    readonly generateDraw: (settings: LobbySettings) => Effect.Effect<Draw, E>;
    readonly validateAnswer: (draw: Draw, playerID: string) => Effect.Effect<boolean, E>;
    readonly getValidPlayers: (draw: Draw) => Effect.Effect<ValidPlayer[], E>;
    readonly searchPlayers: (
      query: string
    ) => Effect.Effect<{ playerID: string; nameFirst: string; nameLast: string }[], E>;
  }
>() {}

export const GameServiceLive = Layer.effect(
  GameService,
  Effect.gen(function* () {
    const db = yield* PgDrizzle;

    return GameService.of({
      generateDraw: (settings) =>
        Effect.gen(function* () {
          const conditions = [
            gte(schema.validDraws.yearID, settings.yearMin),
            lte(schema.validDraws.yearID, settings.yearMax),
          ];

          if (settings.teamPool && settings.teamPool.length > 0) {
            conditions.push(
              inArray(schema.validDraws.teamID, settings.teamPool)
            );
          }

          if (settings.positionPool && settings.positionPool.length > 0) {
            conditions.push(
              inArray(
                schema.validDraws.position,
                settings.positionPool as PositionValue[]
              )
            );
          }

          const results = yield* db
            .select()
            .from(schema.validDraws)
            .where(and(...conditions))
            .orderBy(sql`RANDOM()`)
            .limit(1);

          if (results.length === 0) {
            return yield* Effect.die(
              new Error("No valid draws found for the given settings")
            );
          }

          const row = results[0]!;
          return {
            yearID: row.yearID,
            teamID: row.teamID,
            teamName: row.teamName,
            position: row.position,
          };
        }),

      validateAnswer: (draw, playerID) =>
        Effect.gen(function* () {
          const col = POSITION_COLUMN_MAP[draw.position];
          if (!col) return false;

          const results = yield* db
            .select({ one: sql<number>`1` })
            .from(schema.appearances)
            .where(
              and(
                eq(schema.appearances.yearID, draw.yearID),
                eq(schema.appearances.teamID, draw.teamID),
                eq(schema.appearances.playerID, playerID),
                sql`${sql.identifier(col)} > 0`
              )!
            )
            .limit(1);

          return results.length > 0;
        }),

      getValidPlayers: (draw) =>
        Effect.gen(function* () {
          const col = POSITION_COLUMN_MAP[draw.position];
          if (!col) return [];

          const results = yield* db
            .select({
              playerID: schema.people.playerID,
              nameFirst: schema.people.nameFirst,
              nameLast: schema.people.nameLast,
            })
            .from(schema.appearances)
            .innerJoin(
              schema.people,
              eq(schema.appearances.playerID, schema.people.playerID)
            )
            .where(
              and(
                eq(schema.appearances.yearID, draw.yearID),
                eq(schema.appearances.teamID, draw.teamID),
                sql`${sql.identifier(col)} > 0`
              )!
            )
            .orderBy(schema.people.nameLast, schema.people.nameFirst);

          return results;
        }),

      searchPlayers: (query) =>
        Effect.gen(function* () {
          if (query.length < 2) return [];

          const pattern = `%${query}%`;
          const results = yield* db
            .select({
              playerID: schema.people.playerID,
              nameFirst: schema.people.nameFirst,
              nameLast: schema.people.nameLast,
            })
            .from(schema.people)
            .where(
              sql`(${schema.people.nameFirst} || ' ' || ${schema.people.nameLast}) ILIKE ${pattern}`
            )
            .orderBy(schema.people.nameLast, schema.people.nameFirst)
            .limit(10);

          return results;
        }),
    });
  })
);
