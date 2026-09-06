export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  INTERNAL_TOKEN: string;
  SCORE_THRESHOLD_DEFAULT: string;
  MAX_SOURCES_PER_RUN: string;
}
