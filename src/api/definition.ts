import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiError, OpenApi } from "@effect/platform";
import { Schema } from "effect";

// --- Response schemas ---

export class CreateLobbyResponse extends Schema.Class<CreateLobbyResponse>("CreateLobbyResponse")({
  code: Schema.String.annotations({ description: "4-character lobby room code" }),
}) {}

export class PlayerSearchResult extends Schema.Class<PlayerSearchResult>("PlayerSearchResult")({
  playerID: Schema.String.annotations({ description: "Lahman player ID (e.g. jeterde01)" }),
  nameFirst: Schema.String.annotations({ description: "Player first name" }),
  nameLast: Schema.String.annotations({ description: "Player last name" }),
}) {}

export class PlayerSearchResponse extends Schema.Class<PlayerSearchResponse>("PlayerSearchResponse")({
  results: Schema.Array(PlayerSearchResult).annotations({
    description: "Up to 10 matching players",
  }),
}) {}

// --- Endpoints ---

const createLobby = HttpApiEndpoint.post("createLobby", "/lobby")
  .addSuccess(CreateLobbyResponse, { status: 201 })
  .addError(HttpApiError.InternalServerError)
  .annotate(OpenApi.Summary, "Create a new game lobby")
  .annotate(OpenApi.Description, "Creates a new lobby and returns a 4-character room code. Players connect via WebSocket at /lobby/<code>/ws.");

const searchPlayers = HttpApiEndpoint.get("searchPlayers", "/players/search")
  .setUrlParams(Schema.Struct({
    q: Schema.String.annotations({
      description: "Search query (min 2 characters). Searches player first and last name.",
      examples: ["Jeter", "Hank Aaron"],
    }),
  }))
  .addSuccess(PlayerSearchResponse)
  .addError(HttpApiError.InternalServerError)
  .annotate(OpenApi.Summary, "Search for MLB players")
  .annotate(OpenApi.Description, "Search the Lahman Baseball Database by player name. Returns up to 10 results. Requires at least 2 characters.");

const healthCheck = HttpApiEndpoint.get("healthCheck", "/health")
  .addSuccess(Schema.String)
  .annotate(OpenApi.Summary, "Health check");

// --- Groups ---

const lobbyGroup = HttpApiGroup.make("lobby")
  .add(createLobby)
  .annotate(OpenApi.Title, "Lobby")
  .annotate(OpenApi.Description, "Create and manage game lobbies. All other lobby interactions happen over WebSocket.");

const playersGroup = HttpApiGroup.make("players")
  .add(searchPlayers)
  .annotate(OpenApi.Title, "Players")
  .annotate(OpenApi.Description, "Search the Lahman Baseball Database for players by name.");

const systemGroup = HttpApiGroup.make("system")
  .add(healthCheck)
  .annotate(OpenApi.Title, "System")
  .annotate(OpenApi.Description, "System health endpoints.");

// --- API ---

export const GameApi = HttpApi.make("GameApi")
  .add(lobbyGroup)
  .add(playersGroup)
  .add(systemGroup)
  .annotate(OpenApi.Title, "Luck of the Draw - Baseball Trivia Game")
  .annotate(OpenApi.Version, "1.0.0")
  .annotate(OpenApi.Description,
    "A multiplayer baseball trivia game where players race to name an MLB player matching a random year, team, and position.\n\n" +
    "## Game Flow\n" +
    "1. `POST /lobby` to create a room\n" +
    "2. Connect via WebSocket at `ws://<host>/lobby/<code>/ws?name=<displayName>`\n" +
    "3. Host sends `game:start` over WebSocket\n" +
    "4. Each round: a random year/team/position is shown, players race to answer\n" +
    "5. Use `GET /players/search?q=...` for autocomplete while answering\n\n" +
    "## WebSocket Protocol\n" +
    "**Client -> Server:**\n" +
    "- `{ type: \"lobby:settings\", settings: {...} }` - Host updates settings\n" +
    "- `{ type: \"game:start\" }` - Host starts the game\n" +
    "- `{ type: \"answer:submit\", playerID: \"jeterde01\" }` - Submit an answer\n\n" +
    "**Server -> Client:**\n" +
    "- `lobby:state` - Current lobby state (sent on connect)\n" +
    "- `player:joined` / `player:left` - Player connect/disconnect\n" +
    "- `lobby:settings_updated` - Settings changed\n" +
    "- `lobby:host_changed` - Host migrated\n" +
    "- `game:started` - Game begins\n" +
    "- `round:start` - New round with year/team/position\n" +
    "- `round:end` - Round results with all valid players\n" +
    "- `answer:wrong` / `answer:rejected` - Invalid submission\n" +
    "- `game:sudden_death` - Tie-breaking round\n" +
    "- `game:end` - Final scoreboard"
  );
