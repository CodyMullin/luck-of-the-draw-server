import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { Effect, Cause } from "effect";
import { GameApi, CreateLobbyResponse, PlayerSearchResult, PlayerSearchResponse } from "./definition.ts";
import { LobbyService } from "../services/LobbyService.ts";
import { GameService } from "../services/GameService.ts";
import { GameManager, type GameState } from "../services/GameManager.ts";

const logAndFail = (context: string) => <E>(cause: Cause.Cause<E>) =>
  Effect.sync(() => {
    console.error(`[${context}]`, Cause.pretty(cause));
    return new HttpApiError.InternalServerError();
  }).pipe(Effect.flatMap(Effect.fail));

// --- Lobby group handlers ---

export const LobbyHandlers = HttpApiBuilder.group(GameApi, "lobby", (handlers) =>
  handlers.handle("createLobby", () =>
    Effect.gen(function* () {
      const lobbyService = yield* LobbyService;
      const gameManager = yield* GameManager;

      const result = yield* lobbyService.createLobby();
      const lobby = yield* lobbyService.getLobby(result.code);

      const gameState: GameState = {
        lobbyId: result.lobbyId,
        code: result.code,
        settings: lobby!.settings,
        players: new Map(),
        round: null,
        currentRound: 0,
        totalRounds: lobby!.settings.rounds,
        scores: new Map(),
        phase: "lobby",
        suddenDeathPlayers: null,
        advanceTimer: null,
      };
      yield* gameManager.setGame(result.code, gameState);

      return new CreateLobbyResponse({ code: result.code });
    }).pipe(Effect.catchAllCause(logAndFail("POST /lobby")))
  )
);

// --- Players group handlers ---

export const PlayersHandlers = HttpApiBuilder.group(GameApi, "players", (handlers) =>
  handlers.handle("searchPlayers", ({ urlParams }) =>
    Effect.gen(function* () {
      const gameService = yield* GameService;
      const query = urlParams.q;

      if (query.length < 2) {
        return new PlayerSearchResponse({ results: [] });
      }

      const results = yield* gameService.searchPlayers(query);
      return PlayerSearchResponse.make({
        results: results.map((r) => PlayerSearchResult.make(r)),
      });
    }).pipe(Effect.catchAllCause(logAndFail("GET /players/search")))
  )
);

// --- System group handlers ---

export const SystemHandlers = HttpApiBuilder.group(GameApi, "system", (handlers) =>
  handlers.handle("healthCheck", () => Effect.succeed("ok" as const))
);
