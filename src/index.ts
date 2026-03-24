import { Effect, Layer, Console } from "effect";
import { HttpApiBuilder, HttpApiSwagger, HttpServer } from "@effect/platform";
import { PgDrizzleLayer } from "./db/drizzle.ts";
import { DatabaseLive } from "./db/client.ts";
import { LobbyService, LobbyServiceLive } from "./services/LobbyService.ts";
import { GameService, GameServiceLive } from "./services/GameService.ts";
import { GameManager, GameManagerLive, type GameState } from "./services/GameManager.ts";
import { GameApi } from "./api/definition.ts";
import { LobbyHandlers, PlayersHandlers, SystemHandlers } from "./api/handlers.ts";
import {
  handleMessage,
  handleConnect,
  handleDisconnect,
} from "./ws/handler.ts";

type WsData = {
  code: string;
  displayName: string;
  playerId?: number;
};

// --- Layer composition ---

const DrizzleLive = PgDrizzleLayer.pipe(Layer.provide(DatabaseLive));

const ServicesLive = Layer.mergeAll(
  LobbyServiceLive,
  GameServiceLive,
  GameManagerLive
).pipe(Layer.provide(DrizzleLive));

const ApiLive = HttpApiBuilder.api(GameApi).pipe(
  Layer.provide(LobbyHandlers),
  Layer.provide(PlayersHandlers),
  Layer.provide(SystemHandlers),
  Layer.provide(ServicesLive)
);

const SwaggerLive = HttpApiSwagger.layer({ path: "/docs" }).pipe(
  Layer.provide(ApiLive)
);

const WebHandlerLive = Layer.mergeAll(
  ApiLive,
  SwaggerLive,
  HttpApiBuilder.middlewareCors(),
  HttpServer.layerContext,
);

// --- Main server ---

const startServer = Effect.gen(function* () {
  const lobbyService = yield* LobbyService;
  const gameService = yield* GameService;
  const gameManager = yield* GameManager;

  const { handler, dispose } = HttpApiBuilder.toWebHandler(WebHandlerLive);

  const port = parseInt(process.env.PORT ?? "3000");

  const server = Bun.serve<WsData>({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade for /lobby/:code/ws
      const wsMatch = url.pathname.match(/^\/lobby\/([A-Z0-9]{4})\/ws$/);
      const upgradeHeader = req.headers.get("upgrade");

      if (wsMatch) {
        console.log(`[WS] Match: code=${wsMatch[1]}, upgrade="${upgradeHeader}"`);
      }

      if (wsMatch && upgradeHeader === "websocket") {
        const code = wsMatch[1]!;
        const displayName =
          url.searchParams.get("name") ??
          `Player${Math.floor(Math.random() * 1000)}`;

        let game = await Effect.runPromise(gameManager.getGame(code));
        if (!game) {
          // Try to recover from DB (e.g. after server restart)
          const lobby = await Effect.runPromise(lobbyService.getLobby(code));
          if (!lobby) {
            console.log(`[WS] Lobby not found: ${code}`);
            return new Response("Lobby not found", { status: 404 });
          }
          console.log(`[WS] Recovering lobby from DB: ${code}`);
          const recovered: GameState = {
            lobbyId: lobby.id,
            code: lobby.code,
            settings: lobby.settings,
            players: new Map(),
            round: null,
            currentRound: 0,
            totalRounds: lobby.settings.rounds,
            scores: new Map(),
            phase: "lobby",
            suddenDeathPlayers: null,
            advanceTimer: null,
          };
          await Effect.runPromise(gameManager.setGame(code, recovered));
          game = recovered;
        }

        console.log(`[WS] Upgrading: code=${code}, name=${displayName}`);
        const success = server.upgrade(req, {
          data: { code, displayName },
        });

        console.log(`[WS] Upgrade result: ${success}`);
        return success
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 500 });
      }

      // All other requests go through the HttpApi handler (REST + Swagger)
      return handler(req);
    },
    websocket: {
      async open(ws) {
        const { code, displayName } = ws.data;

        const game = await Effect.runPromise(gameManager.getGame(code));
        if (!game) {
          ws.close(4004, "Lobby not found");
          return;
        }

        const existingPlayer = await Effect.runPromise(
          lobbyService.reconnectPlayer(game.lobbyId, displayName)
        );

        let playerId: number;
        if (existingPlayer) {
          playerId = existingPlayer.id;
        } else {
          const player = await Effect.runPromise(
            lobbyService.joinLobby(code, displayName)
          );
          if (!player) {
            ws.close(4004, "Failed to join lobby");
            return;
          }
          playerId = player.id;
        }

        ws.data.playerId = playerId;

        await Effect.runPromise(
          handleConnect(
            game,
            playerId,
            displayName,
            ws as unknown as WebSocket,
            lobbyService,
            gameManager
          )
        );
      },

      async message(ws, message) {
        const { code, displayName, playerId } = ws.data;
        if (!playerId) return;

        const game = await Effect.runPromise(gameManager.getGame(code));
        if (!game) return;

        try {
          const msg = JSON.parse(
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message as unknown as ArrayBuffer)
          );

          await Effect.runPromise(
            handleMessage(
              game,
              playerId,
              displayName,
              msg,
              ws as unknown as WebSocket,
              gameService,
              lobbyService,
              gameManager
            )
          );
        } catch {
          try {
            ws.send(
              JSON.stringify({ type: "error", message: "Invalid message" })
            );
          } catch {
            // disconnected
          }
        }
      },

      async close(ws) {
        const { code, displayName, playerId } = ws.data;
        if (!playerId) return;

        const game = await Effect.runPromise(gameManager.getGame(code));
        if (!game) return;

        await Effect.runPromise(
          handleDisconnect(
            game,
            playerId,
            displayName,
            lobbyService,
            gameManager
          )
        );
      },
    },
  });

  yield* Console.log(`Server running on http://localhost:${server.port}`);
  yield* Console.log(`Swagger docs at http://localhost:${server.port}/docs`);

  yield* Effect.never;
});

startServer.pipe(Effect.provide(ServicesLive), Effect.runPromise);
