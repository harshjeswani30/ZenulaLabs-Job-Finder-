-- SaaS accounts: email/password users. configs.user_id already exists and
-- references users.id going forward (the legacy 'owner' row is kept as-is).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,  -- pbkdf2:<iterations>:<salt_b64>:<hash_b64>
  created_at INTEGER NOT NULL
);
