-- COINFLIP initial schema.
-- Money is INTEGER ₿ throughout. Floats are only ever intermediate.
-- Every rule the client used to enforce (floor, banking gate, 24h gate) lives
-- here or in the settle path; the client is never trusted with money.

-- ---------------------------------------------------------------------------
-- users — one row per Google account. `id` is our own opaque id; google_sub is
-- the only thing tying it to Google, and it is never exposed to other players.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  google_sub          TEXT NOT NULL UNIQUE,
  email               TEXT,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  display_name        TEXT,
  avatar_url          TEXT,

  -- the economy. wallet is ALWAYS fully at risk; bank is one-way and safe.
  wallet              INTEGER NOT NULL DEFAULT 0,
  bank                INTEGER NOT NULL DEFAULT 0,

  -- the 24h gate. epoch ms. 0 = flip available now.
  next_flip_at        INTEGER NOT NULL DEFAULT 0,

  -- identity (presentation + provenance only — never touches an outcome)
  daringness          REAL NOT NULL DEFAULT 0.5,
  fingerprint_hex     TEXT,

  -- lifetime counters, denormalised so the leaderboard never scans rounds
  flips               INTEGER NOT NULL DEFAULT 0,
  wins                INTEGER NOT NULL DEFAULT 0,
  busts               INTEGER NOT NULL DEFAULT 0,
  edge_hits           INTEGER NOT NULL DEFAULT 0,
  peak_wallet         INTEGER NOT NULL DEFAULT 0,
  best_multiple       REAL    NOT NULL DEFAULT 0,
  banked_total        INTEGER NOT NULL DEFAULT 0,
  total_staked        INTEGER NOT NULL DEFAULT 0,
  total_returned      INTEGER NOT NULL DEFAULT 0,

  -- bump to invalidate every outstanding session for this user
  session_epoch       INTEGER NOT NULL DEFAULT 1,

  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  legacy_imported_at  INTEGER
) STRICT;

CREATE INDEX idx_users_bank        ON users(bank DESC);
CREATE INDEX idx_users_networth    ON users((bank + wallet) DESC);
CREATE INDEX idx_users_best_mult   ON users(best_multiple DESC);
CREATE INDEX idx_users_flips       ON users(flips DESC);
CREATE INDEX idx_users_active      ON users(flips) WHERE flips > 0;

-- ---------------------------------------------------------------------------
-- rounds — one row per flip attempt, and the whole fairness record.
--
-- COMMIT / REVEAL:
--   at open   : server generates `salt` (32 random bytes) and stores it, and
--               publishes ONLY `salt_commit` = sha256(salt). start_face is also
--               pinned here, before the player has placed anything.
--   at lock   : the player's bets + client entropy are frozen, `bets_hash` set.
--   at settle : `salt` is revealed in the response. Because the commit predates
--               the bets, the server provably could not have chosen the salt in
--               response to them.
-- `salt` MUST NOT be selected by any read path while state != 'settled'.
-- ---------------------------------------------------------------------------
CREATE TABLE rounds (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  state             TEXT NOT NULL,          -- open | locked | settled | void
  mode              TEXT NOT NULL,          -- normal | broke | legacy

  salt              TEXT,                   -- hex; secret until settled
  salt_commit       TEXT,                   -- sha256(salt), published at open
  start_face        TEXT,                   -- Heads | Tails, published at open

  opened_at         INTEGER NOT NULL,
  locked_at         INTEGER,
  settled_at        INTEGER,

  stake             INTEGER NOT NULL DEFAULT 0,   -- = wallet at lock
  spread_t          REAL,
  bets_json         TEXT,
  bets_hash         TEXT,
  client_entropy    TEXT,                   -- flick hex, player-authored
  client_clock_ms   INTEGER,                -- flick moment
  identity_hex      TEXT,                   -- provenance only

  seed_hex          TEXT,
  outcome_json      TEXT,
  returned          INTEGER,
  profit            INTEGER,
  multiple          REAL,
  wallet_before     INTEGER,
  wallet_after      INTEGER,
  edge_hit          INTEGER NOT NULL DEFAULT 0,
  imported          INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_rounds_user_time ON rounds(user_id, opened_at DESC);
CREATE INDEX idx_rounds_settled   ON rounds(settled_at DESC);
-- at most one unsettled round per player; enforced by the DB, not by hope.
CREATE UNIQUE INDEX idx_rounds_one_active ON rounds(user_id)
  WHERE state IN ('open', 'locked');

-- ---------------------------------------------------------------------------
-- bank_events — the one-way wallet -> bank ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE bank_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id),
  amount       INTEGER NOT NULL,
  wallet_after INTEGER NOT NULL,
  bank_after   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_bank_events_user ON bank_events(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- legacy_imports — raw localStorage blobs, kept for audit. The money in them is
-- NOT authoritative (see ALLOW_LEGACY_BALANCE_IMPORT).
-- ---------------------------------------------------------------------------
CREATE TABLE legacy_imports (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  payload_json  TEXT NOT NULL,
  days          INTEGER NOT NULL DEFAULT 0,
  claimed_wallet INTEGER,
  claimed_bank  INTEGER,
  money_applied INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_legacy_user ON legacy_imports(user_id);

-- ---------------------------------------------------------------------------
-- stats_snapshots — precomputed leaderboard + population aggregates. Written by
-- the cron trigger (and lazily on a cache miss); read by every player request.
-- ---------------------------------------------------------------------------
CREATE TABLE stats_snapshots (
  key         TEXT PRIMARY KEY,
  json        TEXT NOT NULL,
  computed_at INTEGER NOT NULL
) STRICT;
