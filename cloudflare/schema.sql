-- D1 database schema for Poor Trader Dashboard
-- Run with: wrangler d1 execute poor-trader-db --remote --file=./cloudflare/schema.sql

CREATE TABLE IF NOT EXISTS observations (
  indicator_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  source TEXT NOT NULL,
  meta_json TEXT,
  inserted_at TEXT NOT NULL,
  PRIMARY KEY (indicator_id, as_of)
);

-- "Last updated" reads MAX(inserted_at) on most page loads; without this
-- index every call scans the whole table (D1 bills each row read).
CREATE INDEX IF NOT EXISTS idx_observations_inserted_at ON observations(inserted_at);

CREATE TABLE IF NOT EXISTS market_overview (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  as_of TEXT NOT NULL,
  close REAL NOT NULL,
  chg_1w_pct REAL,
  chg_1m_pct REAL,
  chg_3m_pct REAL,
  chg_1y_pct REAL,
  source_url TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS news_cache (
  cache_key TEXT NOT NULL,
  as_of TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (cache_key, as_of)
);

CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── Watchlist (page 05) ──────────────────────────────────────────────────────
-- User-curated stock repository. `symbol` is normalized (e.g. "NVDA").
CREATE TABLE IF NOT EXISTS watchlist (
  symbol TEXT PRIMARY KEY,
  name TEXT,
  note TEXT,
  added_at TEXT NOT NULL,
  sort_order INTEGER
);

-- Cached computed metrics for each watchlist symbol (refreshed by cron / on
-- demand). `payload_json` holds the full WatchMetrics object.
CREATE TABLE IF NOT EXISTS watchlist_metrics (
  symbol TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  focus_score INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL
);

-- ── Signal log (Watchlist v2) ────────────────────────────────────────────────
-- One row per setup or Special Focus base flagged on the shared watchlist,
-- graded by the cron from daily bars (worker/src/lib/signal-log.ts). R values
-- are multiples of the entry-to-stop risk: r_plan uses the +3R / −1R / 30-day
-- exit, r_trend the breakeven-at-+2R / close-below-21-EMA exit.
-- `source` is 'list' (the shared watchlist, logged and graded by the Worker)
-- or 'scan' (Special Focus names from the daily market scan, which grades its
-- own rows). It was added on 2026-11-28; on a database created before that:
--   ALTER TABLE signal_log ADD COLUMN source TEXT NOT NULL DEFAULT 'list';
CREATE TABLE IF NOT EXISTS signal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'list',   -- list | scan
  symbol TEXT NOT NULL,
  setup TEXT NOT NULL,          -- EP | TIGHT_PB | PB21 | BASE
  label TEXT NOT NULL,
  signal_date TEXT NOT NULL,    -- the finished bar the setup formed on
  entry_type TEXT NOT NULL,     -- close | stop
  trigger REAL NOT NULL,
  stop REAL NOT NULL,
  window INTEGER NOT NULL,      -- sessions the buy-stop stays valid
  status TEXT NOT NULL,         -- pending | missed | open | closed
  entry_date TEXT,
  entry REAL,
  exit_date TEXT,
  r_plan REAL,
  r_trend REAL,
  r_now REAL,
  max_r REAL,
  stress INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (symbol, setup, signal_date)
);
CREATE INDEX IF NOT EXISTS idx_signal_log_status ON signal_log(status, symbol);
CREATE INDEX IF NOT EXISTS idx_signal_log_signal_date ON signal_log(signal_date);

-- ── Market scan (Watchlist v2, Phase 4) ──────────────────────────────────────
-- After each US close, .github/workflows/market-scan.yml runs the Worker's
-- watchlist rules on ~520 stocks (cloudflare/scan/market-scan.ts) and stores
-- the names that would make the Trade Plan: one row per stock and scan date,
-- `payload_json` holding a ScanCandidate (worker/src/lib/market-scan.ts).
-- kv_store `market_scan:last` holds the latest scan's date and counts.
-- Rows older than 90 days are deleted when a new scan is stored.
CREATE TABLE IF NOT EXISTS market_scan (
  scan_date TEXT NOT NULL,      -- the finished session scanned
  symbol TEXT NOT NULL,
  focus_score INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scan_date, symbol)
);
