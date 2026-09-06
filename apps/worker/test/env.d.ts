import type { Env } from "../src/env";

declare module "cloudflare:test" {
  // Augment the test env with the worker's bindings (DB, secrets, vars)
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

export {};
