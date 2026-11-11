-- Initial schema. Never edit a migration that has been deployed: add a new numbered file instead.
-- Times are Unix epoch milliseconds (INTEGER), as returned by Date.now().

-- Keys this app generates for itself on first use (cookie signing, token encryption, VAPID).
CREATE TABLE app_secrets (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Small operational facts shown on /admin (first login, last errors, last webhook).
CREATE TABLE app_state (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per athlete who signed in. Tokens are AES-GCM encrypted (see src/auth/tokens.ts).
CREATE TABLE users (
  id                 TEXT PRIMARY KEY,  -- SweatStack user id (`sub`)
  name               TEXT,
  access_token_enc   TEXT NOT NULL,
  access_expires_at  INTEGER NOT NULL,
  refresh_token_enc  TEXT NOT NULL,
  refresh_lock_until INTEGER,           -- refresh lease, see src/auth/tokens.ts
  created_at         INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL
);

-- Web Push subscriptions. One user can have several devices.
CREATE TABLE push_subscriptions (
  endpoint        TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER
);
CREATE INDEX push_subscriptions_user_id ON push_subscriptions(user_id);

-- Every SweatStack webhook we accepted. The primary key deduplicates retries; rows double as the /admin log.
CREATE TABLE webhook_events (
  id          TEXT PRIMARY KEY,         -- the `webhook-id` header
  event_type  TEXT NOT NULL,
  user_id     TEXT,
  resource_id TEXT,
  status      TEXT NOT NULL,            -- received | notified | skipped | failed
  detail      TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX webhook_events_received_at ON webhook_events(received_at);
