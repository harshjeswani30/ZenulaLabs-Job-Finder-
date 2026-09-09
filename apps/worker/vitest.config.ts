import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/applyMigrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          main: "./src/index.ts",
          miniflare: {
            d1Databases: ["DB"],
            bindings: {
              TEST_MIGRATIONS: migrations,
              INTERNAL_TOKEN: "test-token",
              AUTH_SECRET: "test-auth-secret",
              GROQ_API_KEY: "test",
              TELEGRAM_BOT_TOKEN: "test",
              // Deliberately non-routable: /run-user orchestrates by self-fetching
              // SELF_URL/run-batch, and the cron handler self-fetches SELF_URL/run-user.
              // If this pointed at a real dev server, tests would trigger REAL runs
              // (real sources, real Telegram). Fetches here fail instantly instead.
              SELF_URL: "http://self.invalid",
            },
          },
        },
      },
    },
  };
});
