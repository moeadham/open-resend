import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
  test: {
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Publish to unconsumed queues; tests explicitly dispatch the real handlers.
          // This prevents native consumers from racing isolated-storage rollback.
          queueProducers: { DELIVERY_QUEUE: "contract-deliveries", WEBHOOK_QUEUE: "contract-webhooks" },
          compatibilityDate: "2025-09-06",
          bindings: { TEST_MIGRATIONS: migrations },
        },
      },
    },
  },
});
