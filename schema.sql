CREATE TABLE IF NOT EXISTS balances (
  user_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, currency)
);
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  first_name TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS demo_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  details TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_transactions_user_created
ON demo_transactions(user_id, created_at DESC);


CREATE TABLE IF NOT EXISTS p2p_offers (
  offer_id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  price_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_p2p_offers_status_created ON p2p_offers(status, created_at DESC);
