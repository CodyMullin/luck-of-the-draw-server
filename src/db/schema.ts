import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  primaryKey,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

// --- Enums ---

export const lobbyStatusEnum = pgEnum("lobby_status", [
  "waiting",
  "in_game",
]);

export const positionEnum = pgEnum("field_position", [
  "P",
  "C",
  "1B",
  "2B",
  "3B",
  "SS",
  "LF",
  "CF",
  "RF",
  "DH",
]);

// --- Seeded tables ---

export const people = pgTable(
  "people",
  {
    playerID: text("player_id").primaryKey(),
    nameFirst: text("name_first").notNull(),
    nameLast: text("name_last").notNull(),
    nameGiven: text("name_given"),
  },
  (table) => [
    index("people_name_idx").on(table.nameFirst, table.nameLast),
  ]
);

export const teams = pgTable(
  "teams",
  {
    yearID: integer("year_id").notNull(),
    teamID: text("team_id").notNull(),
    lgID: text("lg_id"),
    name: text("name").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.yearID, table.teamID] }),
  ]
);

export const appearances = pgTable(
  "appearances",
  {
    yearID: integer("year_id").notNull(),
    teamID: text("team_id").notNull(),
    playerID: text("player_id")
      .notNull()
      .references(() => people.playerID),
    gAll: integer("g_all").notNull().default(0),
    gP: integer("g_p").notNull().default(0),
    gC: integer("g_c").notNull().default(0),
    g1b: integer("g_1b").notNull().default(0),
    g2b: integer("g_2b").notNull().default(0),
    g3b: integer("g_3b").notNull().default(0),
    gSs: integer("g_ss").notNull().default(0),
    gLf: integer("g_lf").notNull().default(0),
    gCf: integer("g_cf").notNull().default(0),
    gRf: integer("g_rf").notNull().default(0),
    gDh: integer("g_dh").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.yearID, table.teamID, table.playerID] }),
    index("appearances_lookup_idx").on(
      table.yearID,
      table.teamID
    ),
  ]
);

export const validDraws = pgTable(
  "valid_draws",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    yearID: integer("year_id").notNull(),
    teamID: text("team_id").notNull(),
    teamName: text("team_name").notNull(),
    position: positionEnum("position").notNull(),
  },
  (table) => [
    index("valid_draws_filter_idx").on(
      table.yearID,
      table.teamID,
      table.position
    ),
  ]
);

// --- Runtime tables ---

export type LobbySettings = {
  yearMin: number;
  yearMax: number;
  rounds: number;
  timeLimitSeconds: number;
  teamPool: string[] | null;
  positionPool: string[] | null;
};

export const lobbies = pgTable("lobbies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: text("code").notNull().unique(),
  hostPlayerName: text("host_player_name"),
  status: lobbyStatusEnum("status").notNull().default("waiting"),
  settings: jsonb("settings").$type<LobbySettings>().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at").defaultNow().notNull(),
});

export const lobbyPlayers = pgTable(
  "lobby_players",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    lobbyId: integer("lobby_id")
      .notNull()
      .references(() => lobbies.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    connected: boolean("connected").notNull().default(true),
    score: integer("score").notNull().default(0),
    disconnectedAt: timestamp("disconnected_at"),
  },
  (table) => [
    index("lobby_players_lobby_idx").on(table.lobbyId),
  ]
);
