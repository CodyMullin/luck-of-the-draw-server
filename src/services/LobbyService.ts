import { Context, Effect, Layer } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import { PgDrizzle } from "../db/drizzle.ts";
import * as schema from "../db/schema.ts";
import type { LobbySettings } from "../db/schema.ts";
import { eq, and } from "drizzle-orm";

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

const DEFAULT_SETTINGS: LobbySettings = {
  yearMin: 1960,
  yearMax: 2025,
  rounds: 10,
  timeLimitSeconds: 30,
  teamPool: null,
  positionPool: null,
};

export interface LobbyInfo {
  id: number;
  code: string;
  hostPlayerName: string | null;
  status: "waiting" | "in_game";
  settings: LobbySettings;
}

export interface LobbyPlayerInfo {
  id: number;
  lobbyId: number;
  displayName: string;
  connected: boolean;
  score: number;
}

type E = SqlError;

export class LobbyService extends Context.Tag("LobbyService")<
  LobbyService,
  {
    readonly createLobby: () => Effect.Effect<{ code: string; lobbyId: number }, E>;
    readonly getLobby: (code: string) => Effect.Effect<LobbyInfo | null, E>;
    readonly joinLobby: (
      code: string,
      displayName: string
    ) => Effect.Effect<LobbyPlayerInfo | null, E>;
    readonly leaveLobby: (lobbyId: number, playerId: number) => Effect.Effect<void, E>;
    readonly updateSettings: (
      lobbyId: number,
      settings: Partial<LobbySettings>
    ) => Effect.Effect<void, E>;
    readonly setStatus: (
      lobbyId: number,
      status: "waiting" | "in_game"
    ) => Effect.Effect<void, E>;
    readonly getPlayers: (lobbyId: number) => Effect.Effect<LobbyPlayerInfo[], E>;
    readonly setPlayerConnected: (
      playerId: number,
      connected: boolean
    ) => Effect.Effect<void, E>;
    readonly updateScore: (
      playerId: number,
      score: number
    ) => Effect.Effect<void, E>;
    readonly resetScores: (lobbyId: number) => Effect.Effect<void, E>;
    readonly getHostPlayer: (lobbyId: number) => Effect.Effect<string | null, E>;
    readonly setHostPlayer: (lobbyId: number, displayName: string) => Effect.Effect<void, E>;
    readonly deleteLobby: (lobbyId: number) => Effect.Effect<void, E>;
    readonly touchActivity: (lobbyId: number) => Effect.Effect<void, E>;
    readonly reconnectPlayer: (
      lobbyId: number,
      displayName: string
    ) => Effect.Effect<LobbyPlayerInfo | null, E>;
  }
>() {}

export const LobbyServiceLive = Layer.effect(
  LobbyService,
  Effect.gen(function* () {
    const db = yield* PgDrizzle;

    return LobbyService.of({
      createLobby: () =>
        Effect.gen(function* () {
          const code = generateCode();
          const [lobby] = yield* db
            .insert(schema.lobbies)
            .values({
              code,
              status: "waiting",
              settings: DEFAULT_SETTINGS,
            })
            .returning({ id: schema.lobbies.id });
          return { code, lobbyId: lobby!.id };
        }),

      getLobby: (code) =>
        Effect.gen(function* () {
          const results = yield* db
            .select()
            .from(schema.lobbies)
            .where(eq(schema.lobbies.code, code))
            .limit(1);
          if (results.length === 0) return null;
          const row = results[0]!;
          return {
            id: row.id,
            code: row.code,
            hostPlayerName: row.hostPlayerName,
            status: row.status,
            settings: row.settings,
          };
        }),

      joinLobby: (code, displayName) =>
        Effect.gen(function* () {
          const results = yield* db
            .select()
            .from(schema.lobbies)
            .where(eq(schema.lobbies.code, code))
            .limit(1);
          if (results.length === 0) return null;
          const lobby = results[0]!;

          const [player] = yield* db
            .insert(schema.lobbyPlayers)
            .values({
              lobbyId: lobby.id,
              displayName,
              connected: true,
              score: 0,
            })
            .returning();

          if (!lobby.hostPlayerName) {
            yield* db
              .update(schema.lobbies)
              .set({ hostPlayerName: displayName })
              .where(eq(schema.lobbies.id, lobby.id));
          }

          return {
            id: player!.id,
            lobbyId: lobby.id,
            displayName: player!.displayName,
            connected: player!.connected,
            score: player!.score,
          };
        }),

      leaveLobby: (_lobbyId, playerId) =>
        db
          .delete(schema.lobbyPlayers)
          .where(eq(schema.lobbyPlayers.id, playerId))
          .pipe(Effect.asVoid),

      updateSettings: (lobbyId, settings) =>
        Effect.gen(function* () {
          const results = yield* db
            .select({ settings: schema.lobbies.settings })
            .from(schema.lobbies)
            .where(eq(schema.lobbies.id, lobbyId))
            .limit(1);
          if (results.length === 0) return;
          const current = results[0]!.settings;
          yield* db
            .update(schema.lobbies)
            .set({ settings: { ...current, ...settings } })
            .where(eq(schema.lobbies.id, lobbyId));
        }),

      setStatus: (lobbyId, status) =>
        db
          .update(schema.lobbies)
          .set({ status })
          .where(eq(schema.lobbies.id, lobbyId))
          .pipe(Effect.asVoid),

      getPlayers: (lobbyId) =>
        db
          .select({
            id: schema.lobbyPlayers.id,
            lobbyId: schema.lobbyPlayers.lobbyId,
            displayName: schema.lobbyPlayers.displayName,
            connected: schema.lobbyPlayers.connected,
            score: schema.lobbyPlayers.score,
          })
          .from(schema.lobbyPlayers)
          .where(eq(schema.lobbyPlayers.lobbyId, lobbyId)),

      setPlayerConnected: (playerId, connected) =>
        db
          .update(schema.lobbyPlayers)
          .set({
            connected,
            disconnectedAt: connected ? null : new Date(),
          })
          .where(eq(schema.lobbyPlayers.id, playerId))
          .pipe(Effect.asVoid),

      updateScore: (playerId, score) =>
        db
          .update(schema.lobbyPlayers)
          .set({ score })
          .where(eq(schema.lobbyPlayers.id, playerId))
          .pipe(Effect.asVoid),

      resetScores: (lobbyId) =>
        db
          .update(schema.lobbyPlayers)
          .set({ score: 0 })
          .where(eq(schema.lobbyPlayers.lobbyId, lobbyId))
          .pipe(Effect.asVoid),

      getHostPlayer: (lobbyId) =>
        Effect.gen(function* () {
          const results = yield* db
            .select({ hostPlayerName: schema.lobbies.hostPlayerName })
            .from(schema.lobbies)
            .where(eq(schema.lobbies.id, lobbyId))
            .limit(1);
          return results[0]?.hostPlayerName ?? null;
        }),

      setHostPlayer: (lobbyId, displayName) =>
        db
          .update(schema.lobbies)
          .set({ hostPlayerName: displayName })
          .where(eq(schema.lobbies.id, lobbyId))
          .pipe(Effect.asVoid),

      deleteLobby: (lobbyId) =>
        db
          .delete(schema.lobbies)
          .where(eq(schema.lobbies.id, lobbyId))
          .pipe(Effect.asVoid),

      touchActivity: (lobbyId) =>
        db
          .update(schema.lobbies)
          .set({ lastActivityAt: new Date() })
          .where(eq(schema.lobbies.id, lobbyId))
          .pipe(Effect.asVoid),

      reconnectPlayer: (lobbyId, displayName) =>
        Effect.gen(function* () {
          const results = yield* db
            .select()
            .from(schema.lobbyPlayers)
            .where(
              and(
                eq(schema.lobbyPlayers.lobbyId, lobbyId),
                eq(schema.lobbyPlayers.displayName, displayName)
              )
            )
            .limit(1);
          if (results.length === 0) return null;
          const player = results[0]!;
          yield* db
            .update(schema.lobbyPlayers)
            .set({ connected: true, disconnectedAt: null })
            .where(eq(schema.lobbyPlayers.id, player.id));
          return {
            id: player.id,
            lobbyId: player.lobbyId,
            displayName: player.displayName,
            connected: true,
            score: player.score,
          };
        }),
    });
  })
);
