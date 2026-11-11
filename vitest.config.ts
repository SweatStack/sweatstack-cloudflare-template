import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside the real Workers runtime (workerd) with a real, local D1 database.
// SweatStack itself is never called: tests pass a fake `fetch` to createApp() (see test/helpers.ts).
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SWEATSTACK_CLIENT_ID: "test-client-id",
            SWEATSTACK_CLIENT_SECRET: "test-client-secret",
            ADMIN_USER_IDS: "admin-user",
            // base64 of "test-webhook-signing-key-32bytes"
            SWEATSTACK_WEBHOOK_SECRET: "whsec_dGVzdC13ZWJob29rLXNpZ25pbmcta2V5LTMyYnl0ZXM=",
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});
