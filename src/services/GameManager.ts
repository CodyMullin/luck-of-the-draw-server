import { Context, Effect, Layer, Ref } from "effect";
import type { Draw, ValidPlayer } from "./GameService.ts";
import type { LobbySettings } from "../db/schema.ts";

export interface PlayerConnection {
  playerId: number;
  displayName: string;
  ws: WebSocket;
}

export interface RoundState {
  roundNumber: number;
  draw: Draw;
  validPlayers: ValidPlayer[];
  startedAt: number;
  timer: Timer | null;
  answered: boolean;
  winnerId: number | null;
  winnerName: string | null;
  selectedPlayerID: string | null;
}

export interface GameState {
  lobbyId: number;
  code: string;
  settings: LobbySettings;
  players: Map<number, PlayerConnection>;
  round: RoundState | null;
  currentRound: number;
  totalRounds: number;
  scores: Map<number, number>;
  phase: "lobby" | "playing" | "between_rounds" | "sudden_death" | "game_over";
  suddenDeathPlayers: Set<number> | null;
  advanceTimer: Timer | null;
}

export class GameManager extends Context.Tag("GameManager")<
  GameManager,
  {
    readonly games: Ref.Ref<Map<string, GameState>>;
    readonly getGame: (code: string) => Effect.Effect<GameState | undefined>;
    readonly setGame: (code: string, game: GameState) => Effect.Effect<void>;
    readonly deleteGame: (code: string) => Effect.Effect<void>;
  }
>() {}

export const GameManagerLive = Layer.effect(
  GameManager,
  Effect.gen(function* () {
    const gamesRef = yield* Ref.make(new Map<string, GameState>());

    return GameManager.of({
      games: gamesRef,
      getGame: (code) => Ref.get(gamesRef).pipe(Effect.map((m) => m.get(code))),
      setGame: (code, game) =>
        Ref.update(gamesRef, (m) => {
          const next = new Map(m);
          next.set(code, game);
          return next;
        }),
      deleteGame: (code) =>
        Ref.update(gamesRef, (m) => {
          const next = new Map(m);
          next.delete(code);
          return next;
        }),
    });
  })
);
