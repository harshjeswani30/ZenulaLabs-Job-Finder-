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
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
