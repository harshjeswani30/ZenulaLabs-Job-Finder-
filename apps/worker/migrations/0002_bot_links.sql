-- One-time connect tokens for the "Connect Bot" flow: web generates a token,
-- user taps START in Telegram (deep link ?start=<token>), the bot webhook
-- matches the token to the chat and links it. Rows expire after 15 minutes.
CREATE TABLE bot_links (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'owner',
  chat_id TEXT,
  telegram_username TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | linked | expired
  created_at INTEGER NOT NULL,
  linked_at INTEGER
);

CREATE INDEX idx_bot_links_status ON bot_links(status, created_at);
