import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";

// Every test file starts from a fresh, migrated local D1 database.
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
