import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const deploymentPath = resolve(root, process.env.DEPLOYMENT_CONFIG ?? ".deployment.json");
const outputPath = resolve(root, process.env.WRANGLER_DEPLOY_CONFIG ?? "wrangler.deploy.jsonc");

const deployment = readJson(deploymentPath, `Copy .deployment.example.json to ${deploymentPath} and fill in its values.`);
const terraformOutputs = readTerraformOutputs();
const base = readJson(resolve(root, "wrangler.jsonc"));

const adminHostname = output(terraformOutputs, "admin_hostname");
const accessAud = output(terraformOutputs, "access_aud");
const accessTeamDomain = output(terraformOutputs, "access_team_domain");
const apiHostname = requireHostname(deployment.apiHostname, "apiHostname");
const unsubscribeHostnames = requireHostnameMap(deployment.unsubscribeHostnames, "unsubscribeHostnames");
const sendingDomains = discoverSendingDomains();
requireHostname(adminHostname, "Terraform output admin_hostname");

for (const hostname of Object.values(unsubscribeHostnames)) {
  if (hostname === adminHostname) fail("An unsubscribe hostname cannot be the Access-protected admin hostname.");
}

if (!isUuid(deployment.d1DatabaseId) || deployment.d1DatabaseId === "00000000-0000-0000-0000-000000000000") {
  fail("d1DatabaseId must be the UUID of a provisioned D1 database.");
}

const deliveryQueue = optionalString(deployment.deliveryQueue, "cloudflare-resend-deliveries");
const deadLetterQueue = optionalString(deployment.deadLetterQueue, "cloudflare-resend-deliveries-dlq");
const emailEventsQueue = optionalString(deployment.emailEventsQueue, "cloudflare-resend-email-events");

const config = {
  ...base,
  name: optionalString(deployment.workerName, "cloudflare-resend"),
  routes: deduplicateRoutes([
    { pattern: adminHostname, custom_domain: true },
    { pattern: apiHostname, custom_domain: true },
    ...Object.values(unsubscribeHostnames).map((pattern) => ({ pattern, custom_domain: true })),
  ]),
  d1_databases: base.d1_databases.map((database) =>
    database.binding === "DB"
      ? {
          ...database,
          database_name: optionalString(deployment.d1DatabaseName, "cloudflare-resend"),
          database_id: deployment.d1DatabaseId,
        }
      : database,
  ),
  queues: {
    producers: base.queues.producers.map((producer) =>
      producer.binding === "DELIVERY_QUEUE" ? { ...producer, queue: deliveryQueue } : producer,
    ),
    consumers: [
      { ...base.queues.consumers[0], queue: deliveryQueue, dead_letter_queue: deadLetterQueue },
      { ...base.queues.consumers[1], queue: emailEventsQueue },
      { ...base.queues.consumers[2], queue: deadLetterQueue },
    ],
  },
  vars: {
    ...base.vars,
    ADMIN_HOSTNAME: adminHostname,
    API_HOSTNAME: apiHostname,
    UNSUBSCRIBE_HOSTNAMES: JSON.stringify(unsubscribeHostnames),
    SENDING_DOMAINS: JSON.stringify(sendingDomains),
    ACCESS_TEAM_DOMAIN: accessTeamDomain,
    ACCESS_AUD: accessAud,
    ENVIRONMENT: optionalString(deployment.environment, "production"),
    ALLOW_LOCAL_ADMIN: "false",
  },
};

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Rendered ${outputPath}`);

function readTerraformOutputs() {
  const fixture = process.env.TERRAFORM_OUTPUT_JSON;
  if (fixture) return readJson(resolve(root, fixture));

  const terraform = process.env.TERRAFORM_BIN ?? "terraform";
  try {
    const json = execFileSync(terraform, ["-chdir=infra/access", "output", "-json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    return JSON.parse(json);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("Terraform is not installed. Install Terraform 1.10+ or set TERRAFORM_BIN.");
    }
    fail("Could not read Terraform outputs. Run terraform -chdir=infra/access apply first.");
  }
}

function discoverSendingDomains() {
  const fixture = process.env.SENDING_DOMAINS_JSON;
  if (fixture) {
    try {
      const domains = JSON.parse(fixture);
      if (!Array.isArray(domains)) throw new Error("not an array");
      return normalizeSendingDomains(domains);
    } catch {
      fail("SENDING_DOMAINS_JSON must be a JSON array of hostnames.");
    }
  }

  try {
    const output = execFileSync(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "email", "sending", "list"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const domains = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes("│")) continue;
      const columns = line.split("│").slice(1, -1).map((value) => value.trim());
      if (columns.length >= 3 && columns[0] !== "zone" && columns[2] === "yes") domains.push(columns[1]);
    }
    return normalizeSendingDomains(domains);
  } catch {
    fail("Could not discover Cloudflare Email Sending domains. Run `npx wrangler email sending list` and confirm Wrangler is authenticated.");
  }
}

function normalizeSendingDomains(values) {
  const domains = [...new Set(values.map((value) => requireHostname(value, "Email Sending domain")))].sort();
  if (!domains.length) fail("No enabled Cloudflare Email Sending domains were found for this account.");
  return domains;
}

function output(outputs, name) {
  const value = outputs?.[name]?.value;
  if (typeof value !== "string" || value.length === 0) fail(`Terraform output ${name} is missing.`);
  return value;
}

function readJson(path, hint) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${error.message}${hint ? ` ${hint}` : ""}`);
  }
}

function requireHostname(value, name) {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(value)) {
    fail(`${name} must be a hostname without a scheme, path, or wildcard.`);
  }
  return value.toLowerCase();
}

function requireHostnameMap(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${name} must be an object mapping sending domains to unsubscribe hostnames.`);
  }
  const result = {};
  for (const [sendingDomain, unsubscribeHostname] of Object.entries(value)) {
    const normalizedSendingDomain = requireHostname(sendingDomain, `${name} sending domain`);
    result[normalizedSendingDomain] = requireHostname(unsubscribeHostname, `${name}.${sendingDomain}`);
  }
  return result;
}

function deduplicateRoutes(routes) {
  const seen = new Set();
  return routes.filter(({ pattern }) => {
    if (seen.has(pattern)) return false;
    seen.add(pattern);
    return true;
  });
}

function optionalString(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) fail("Deployment string values cannot be empty.");
  return value;
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function fail(message) {
  console.error(`Deployment configuration error: ${message}`);
  process.exit(1);
}
