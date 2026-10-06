import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cloudflare-resend-config-"));
const outputPath = join(temporaryDirectory, "wrangler.deploy.jsonc");

try {
  const result = spawnSync(process.execPath, ["scripts/render-wrangler.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DEPLOYMENT_CONFIG: "test/fixtures/deployment.json",
      TERRAFORM_OUTPUT_JSON: "test/fixtures/terraform-output.json",
      SENDING_DOMAINS_JSON: '["example.com","another-domain.com"]',
      WRANGLER_DEPLOY_CONFIG: outputPath,
    },
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const config = JSON.parse(readFileSync(outputPath, "utf8"));
  assert(config.name === "cloudflare-resend-test", "worker name was not rendered");
  assert(config.routes[0].pattern === "mail-admin.example.com", "admin route was not rendered from Terraform");
  assert(config.routes[1].pattern === "mail-api.example.com", "API route was not rendered from deployment settings");
  assert(config.routes[2].pattern === "mail.example.com", "first unsubscribe route was not rendered");
  assert(config.routes[3].pattern === "mail.another-domain.com", "second unsubscribe route was not rendered");
  assert(config.vars.UNSUBSCRIBE_HOSTNAMES === JSON.stringify({ "example.com": "mail.example.com", "another-domain.com": "mail.another-domain.com" }), "unsubscribe hostname map was not rendered");
  assert(config.vars.SENDING_DOMAINS === JSON.stringify(["another-domain.com", "example.com"]), "Email Sending domains were not rendered");
  assert(config.vars.ACCESS_AUD === "example-access-audience", "Access audience was not rendered");
  assert(config.vars.ACCESS_TEAM_DOMAIN === "example.cloudflareaccess.com", "Access team domain was not rendered");
  assert(config.vars.ALLOW_LOCAL_ADMIN === "false", "production config must disable the local bypass");
  assert(config.d1_databases[0].database_id === "00000000-0000-4000-8000-000000000003", "D1 ID was not rendered");
  assert(config.queues.consumers[0].dead_letter_queue === "cloudflare-resend-test-deliveries-dlq", "DLQ was not rendered");

  console.log("Deployment configuration rendering verified.");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
