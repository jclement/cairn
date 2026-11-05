import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc", environment: "local" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            CAIRN_FAKE_EMBEDDINGS: "1",
            CAIRN_FAKE_JEV: "1",
            CAIRN_FAKE_LLM: "1",
            IMPORT_ENABLED: "true",
            CAIRN_EMBED_ALARM: "off",
            CAIRN_TEST_HOOKS: "1",
            CAIRN_FAKE_CAPTURE_AI: "1",
            CAIRN_SETUP_TOKEN: "test-setup-token-0123456789",
          },
        },
      }),
    ],
    // Generous timeouts: the first run on a loaded machine (heavy queue, cold workerd) can be slow;
    // tests assert outcomes, never timing.
    test: { setupFiles: ["./test/setup.ts"], testTimeout: 30_000, hookTimeout: 60_000 },
  };
});
