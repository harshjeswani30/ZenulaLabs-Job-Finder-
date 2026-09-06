CREATE TABLE configs (
  user_id TEXT PRIMARY KEY,
  fields TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  sites TEXT NOT NULL DEFAULT '[]',
  filters TEXT NOT NULL DEFAULT '{}',
  score_threshold INTEGER NOT NULL DEFAULT 70,
  cadence_hours INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  telegram_chat_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  hash TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  salary TEXT,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  description_snippet TEXT NOT NULL,
  posted_at INTEGER,
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE user_jobs (
  user_id TEXT NOT NULL,
  job_hash TEXT NOT NULL REFERENCES jobs(hash),
  first_seen_at INTEGER NOT NULL,
  sent_at INTEGER,
  score INTEGER,
  PRIMARY KEY (user_id, job_hash)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  sources_ok INTEGER NOT NULL DEFAULT 0,
  sources_failed INTEGER NOT NULL DEFAULT 0,
  jobs_found INTEGER NOT NULL DEFAULT 0,
  jobs_sent INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_jobs_first_seen ON jobs(first_seen_at);
CREATE INDEX idx_user_jobs_unsent ON user_jobs(user_id, sent_at);
CREATE INDEX idx_configs_due ON configs(is_active, next_run_at);
