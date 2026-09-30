-- The SafeSpace vault (Cloudflare D1). The server keeps only what the browser could not keep alone:
-- a salt, hashes of two keys, two wrapped copies of the data key and ciphertext. Nothing here can be
-- decrypted without the user's password or recovery key. Times are ms since epoch.

CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,           -- random UUID
  email            TEXT NOT NULL UNIQUE,       -- trimmed, lowercased
  salt             TEXT NOT NULL,              -- the client's PBKDF2 salt (16 bytes, base64url)
  auth_hash        TEXT NOT NULL,              -- pbkdf2_sha256$<iter>$<salt>$<hash> of authKey
  recovery_hash    TEXT NOT NULL,              -- the same, of recoveryAuth
  wrapped_password TEXT NOT NULL,              -- JSON {iv, ct}: the data key under wrapKey
  wrapped_recovery TEXT NOT NULL,              -- JSON {iv, ct}: the data key under recoveryWrap
  seq              INTEGER NOT NULL DEFAULT 0, -- last change number handed to one of this user's records
  pruned_seq       INTEGER NOT NULL DEFAULT 0, -- highest seq of a tombstone deleted by the cron
  created_at       INTEGER NOT NULL
);

-- One row per signed-in device. id is SHA-256 (hex) of the cookie's token; the token itself is never stored.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

-- Sealed records. seq orders every change to a user's records (the pull cursor). A deleted record
-- stays as a tombstone (iv, ct empty, deleted = 1) for 90 days so other devices learn about it.
CREATE TABLE IF NOT EXISTS records (
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  id         TEXT NOT NULL,                    -- client-made UUID
  kind       TEXT NOT NULL,
  iv         TEXT NOT NULL,
  ct         TEXT NOT NULL,
  bytes      INTEGER NOT NULL,                 -- length of iv + ct as sent (counts towards the 5 MB)
  version    INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS records_seq ON records (user_id, seq);
CREATE INDEX IF NOT EXISTS records_tombstones ON records (deleted, updated_at);

-- Fixed-window counters for limits the Workers rate limiter cannot express (it only knows 10 s and
-- 60 s): signups per IP per hour, narrations per user per hour. key is a hash, never a raw IP.
CREATE TABLE IF NOT EXISTS counters (
  key    TEXT NOT NULL,
  hour   INTEGER NOT NULL,                     -- start of the hour, ms
  n      INTEGER NOT NULL,
  PRIMARY KEY (key, hour)
) WITHOUT ROWID;
