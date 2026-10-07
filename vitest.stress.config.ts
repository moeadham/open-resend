import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
  test: {
    include: ["test/stress.emulator.ts"],
    testTimeout: 180_000,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          compatibilityDate: "2025-05-08",
          bindings: { TEST_MIGRATIONS: migrations },
        },
      },
    },
  },
});
