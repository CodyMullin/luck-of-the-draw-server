import { Effect, type Context } from "effect";
import { GameManager, type GameState, type PlayerConnection } from "../services/GameManager.ts";
import { GameService, type Draw } from "../services/GameService.ts";
import { LobbyService } from "../services/LobbyService.ts";

// --- Service types ---

type GameServiceI = Context.Tag.Service<typeof GameService>;
type LobbyServiceI = Context.Tag.Service<typeof LobbyService>;
type GameManagerI = Context.Tag.Service<typeof GameManager>;

// --- Message types ---

interface LobbySettingsMsg {
  type: "lobby:settings";
  settings: Record<string, unknown>;
}

interface GameStartMsg {
  type: "game:start";
}

interface AnswerSubmitMsg {
  type: "answer:submit";
  playerID: string;
}

type ClientMessage = LobbySettingsMsg | GameStartMsg | AnswerSubmitMsg;

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

function broadcast(game: GameState, msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const player of game.players.values()) {
    try {
      player.ws.send(data);
    } catch {
      // player disconnected
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // disconnected
  }
}

function getScoreboard(game: GameState): { displayName: string; score: number }[] {
  const board: { displayName: string; score: number }[] = [];
  for (const [playerId, conn] of game.players) {
    board.push({
      displayName: conn.displayName,
      score: game.scores.get(playerId) ?? 0,
    });
  }
  return board.sort((a, b) => b.score - a.score);
}

// --- Round logic ---

function startRound(
  game: GameState,
  gameService: GameServiceI,
  lobbyService: LobbyServiceI,
  gameManager: GameManagerI
): Effect.Effect<void, any> {
  return Effect.gen(function* () {
    game.currentRound++;
    const draw = yield* gameService.generateDraw(game.settings);
    const validPlayers = yield* gameService.getValidPlayers(draw);

    const round = {
      roundNumber: game.currentRound,
      draw,
      validPlayers,
      startedAt: Date.now(),
      timer: null as Timer | null,
      answered: false,
      winnerId: null as number | null,
      winnerName: null as string | null,
      selectedPlayerID: null as string | null,
    };

    game.round = round;
    game.phase = "playing";
    yield* gameManager.setGame(game.code, game);

    broadcast(game, {
      type: "round:start",
      roundNumber: round.roundNumber,
      totalRounds: game.totalRounds,
      year: draw.yearID,
      teamName: draw.teamName,
      position: draw.position,
      timeLimit: game.settings.timeLimitSeconds,
    });

    round.timer = setTimeout(() => {
      Effect.runPromise(
        endRound(game, gameService, lobbyService, gameManager)
      );
    }, game.settings.timeLimitSeconds * 1000);
  });
}

function endRound(
  game: GameState,
  gameService: GameServiceI,
  lobbyService: LobbyServiceI,
  gameManager: GameManagerI
): Effect.Effect<void, any> {
  return Effect.gen(function* () {
    const round = game.round;
    if (!round) return;

    if (round.timer) {
      clearTimeout(round.timer);
      round.timer = null;
    }

    game.phase = "between_rounds";

    for (const [playerId, score] of game.scores) {
      yield* lobbyService.updateScore(playerId, score);
    }

    broadcast(game, {
      type: "round:end",
      roundNumber: round.roundNumber,
      draw: round.draw,
      winnerId: round.winnerId,
      winnerName: round.winnerName,
      selectedPlayerID: round.selectedPlayerID,
      validPlayers: round.validPlayers.map((p) => ({
        playerID: p.playerID,
        nameFirst: p.nameFirst,
        nameLast: p.nameLast,
      })),
      validPlayerCount: round.validPlayers.length,
      scoreboard: getScoreboard(game),
    });

    yield* gameManager.setGame(game.code, game);

    game.advanceTimer = setTimeout(() => {
      Effect.runPromise(
        advanceGame(game, gameService, lobbyService, gameManager)
      );
    }, 30_000);
  });
}

function advanceGame(
  game: GameState,
  gameService: GameServiceI,
  lobbyService: LobbyServiceI,
  gameManager: GameManagerI
): Effect.Effect<void, any> {
  return Effect.gen(function* () {
    if (game.advanceTimer) {
      clearTimeout(game.advanceTimer);
      game.advanceTimer = null;
    }

    const isSuddenDeath =
      game.phase === "sudden_death" || game.currentRound >= game.totalRounds;

    if (isSuddenDeath && game.phase !== "sudden_death") {
      const scoreboard = getScoreboard(game);
      const topScore = scoreboard[0]?.score ?? 0;
      const tiedPlayers = scoreboard.filter((p) => p.score === topScore);

      if (tiedPlayers.length > 1) {
        game.phase = "sudden_death";
        const tiedIds = new Set<number>();
        for (const [playerId, conn] of game.players) {
          if (tiedPlayers.some((tp) => tp.displayName === conn.displayName)) {
            tiedIds.add(playerId);
          }
        }
        game.suddenDeathPlayers = tiedIds;

        broadcast(game, {
          type: "game:sudden_death",
          tiedPlayers: tiedPlayers.map((p) => p.displayName),
          scoreboard: getScoreboard(game),
        });

        yield* gameManager.setGame(game.code, game);
        yield* startRound(game, gameService, lobbyService, gameManager);
        return;
      }
    }

    if (game.phase === "sudden_death") {
      const scoreboard = getScoreboard(game);
      const topScore = scoreboard[0]?.score ?? 0;
      const tiedPlayers = scoreboard.filter((p) => p.score === topScore);

      if (tiedPlayers.length > 1) {
        yield* startRound(game, gameService, lobbyService, gameManager);
        return;
      }
    }

    if (game.currentRound >= game.totalRounds || game.phase === "sudden_death") {
      game.phase = "game_over";
      yield* lobbyService.setStatus(game.lobbyId, "waiting");
      yield* lobbyService.resetScores(game.lobbyId);

      broadcast(game, {
        type: "game:end",
        scoreboard: getScoreboard(game),
      });

      game.currentRound = 0;
      game.round = null;
      game.scores = new Map();
      game.suddenDeathPlayers = null;
      game.phase = "lobby";
      for (const [playerId] of game.players) {
        game.scores.set(playerId, 0);
      }

      yield* gameManager.setGame(game.code, game);
      return;
    }

    yield* startRound(game, gameService, lobbyService, gameManager);
  });
}

// --- Handle incoming WS messages ---

export function handleMessage(
  game: GameState,
  playerId: number,
  displayName: string,
  msg: ClientMessage,
  ws: WebSocket,
  gameService: GameServiceI,
  lobbyService: LobbyServiceI,
  gameManager: GameManagerI
): Effect.Effect<void, any> {
  return Effect.gen(function* () {
    switch (msg.type) {
      case "lobby:settings": {
        const host = yield* lobbyService.getHostPlayer(game.lobbyId);
        if (host !== displayName) {
          send(ws, { type: "error", message: "Only the host can change settings" });
          return;
        }
        if (game.phase !== "lobby") {
          send(ws, { type: "error", message: "Cannot change settings during a game" });
          return;
        }
        yield* lobbyService.updateSettings(game.lobbyId, msg.settings as any);
        Object.assign(game.settings, msg.settings);
        game.totalRounds = game.settings.rounds;
        yield* gameManager.setGame(game.code, game);

        broadcast(game, {
          type: "lobby:settings_updated",
          settings: game.settings,
        });
        break;
      }

      case "game:start": {
        const host = yield* lobbyService.getHostPlayer(game.lobbyId);
        if (host !== displayName) {
          send(ws, { type: "error", message: "Only the host can start the game" });
          return;
        }
        if (game.phase !== "lobby" && game.phase !== "game_over") {
          send(ws, { type: "error", message: "Game is already in progress" });
          return;
        }

        yield* lobbyService.setStatus(game.lobbyId, "in_game");
        game.currentRound = 0;
        game.totalRounds = game.settings.rounds;
        game.phase = "playing";
        game.suddenDeathPlayers = null;

        for (const [pid] of game.players) {
          game.scores.set(pid, 0);
        }
        yield* lobbyService.resetScores(game.lobbyId);
        yield* gameManager.setGame(game.code, game);

        broadcast(game, {
          type: "game:started",
          settings: game.settings,
          players: Array.from(game.players.values()).map((p) => p.displayName),
        });

        yield* startRound(game, gameService, lobbyService, gameManager);
        break;
      }

      case "answer:submit": {
        if (game.phase !== "playing" || !game.round || game.round.answered) {
          send(ws, { type: "answer:rejected", reason: "No active round" });
          return;
        }

        if (game.suddenDeathPlayers && !game.suddenDeathPlayers.has(playerId)) {
          send(ws, {
            type: "answer:rejected",
            reason: "Only tied players can answer in sudden death",
          });
          return;
        }

        const isValid = yield* gameService.validateAnswer(
          game.round.draw,
          msg.playerID
        );

        if (!isValid) {
          send(ws, { type: "answer:wrong", playerID: msg.playerID });
          return;
        }

        game.round.answered = true;
        game.round.winnerId = playerId;
        game.round.winnerName = displayName;
        game.round.selectedPlayerID = msg.playerID;
        const currentScore = game.scores.get(playerId) ?? 0;
        game.scores.set(playerId, currentScore + 1);

        const selectedPlayer = game.round.validPlayers.find(
          (p) => p.playerID === msg.playerID
        );

        broadcast(game, {
          type: "answer:correct",
          winnerName: displayName,
          selectedPlayerID: msg.playerID,
          selectedPlayerName: selectedPlayer
            ? `${selectedPlayer.nameFirst} ${selectedPlayer.nameLast}`
            : null,
        });

        yield* endRound(game, gameService, lobbyService, gameManager);
        break;
      }
    }
  });
}

// --- Connection management ---

export function handleConnect(
  game: GameState,
  playerId: number,
  displayName: string,
  ws: WebSocket,
  lobbyService: LobbyServiceI,
  gameManager: GameManagerI
): Effect.Effect<void, any> {
  return Effect.gen(function* () {
    game.players.set(playerId, { playerId, displayName, ws });
    if (!game.scores.has(playerId)) {
      game.scores.set(playerId, 0);
    }
    yield* gameManager.setGame(game.code, game);
    yield* lobbyService.touchActivity(game.lobbyId);

    broadcast(game, {
      type: "player:joined",
      displayName,
      players: Array.from(game.players.values()).map((p) => p.displayName),
      scoreboard: getScoreboard(game),
    });

    const host = yield* lobbyService.getHostPlayer(game.lobbyId);
    send(ws, {
      type: "lobby:state",
      code: game.code,
      phase: game.phase,
      settings: game.settings,
      host,
      players: Array.from(game.players.values()).map((p) => p.displayName),
      scoreboard: getScoreboard(game),
      ...(game.round && game.phase === "playing"
        ? {
            currentRound: {
              roundNumber: game.round.roundNumber,
              year: game.round.draw.yearID,
              teamName: game.round.draw.teamName,
              position: game.round.draw.position,
              elapsed: Math.floor((Date.now() - game.round.startedAt) / 1000),
            },
          }
        : {}),
    });
  });
}

export function handleDisconnect(
  game: GameState,
  playerId: number,
  displayName: string,
  lobbyService: LobbyServiceI,
  gameManager: GameManagerI
): Effect.Effect<void, any> {
  return Effect.gen(function* () {
    game.players.delete(playerId);
    yield* lobbyService.setPlayerConnected(playerId, false);
    yield* gameManager.setGame(game.code, game);

    broadcast(game, {
      type: "player:left",
      displayName,
      players: Array.from(game.players.values()).map((p) => p.displayName),
    });

    if (game.players.size === 0) {
      yield* lobbyService.touchActivity(game.lobbyId);
    }

    if (game.phase === "lobby") {
      const host = yield* lobbyService.getHostPlayer(game.lobbyId);
      if (host === displayName && game.players.size > 0) {
        const nextHost = game.players.values().next().value!;
        yield* lobbyService.setHostPlayer(game.lobbyId, nextHost.displayName);
        broadcast(game, {
          type: "lobby:host_changed",
          host: nextHost.displayName,
        });
      }
    }
  });
}
