import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentPath = resolve(root, ".deployment.json");
const terraformVarsPath = resolve(root, "infra/access/terraform.tfvars");
const tokenPermissions = [
  { key: "access", type: "edit" },
  { key: "access_acct", type: "read" },
];
const emailEvents = [
  "message.delivered",
  "message.deferred",
  "message.bounced",
  "message.failed",
  "message.rejected",
  "message.complained",
];

let temporaryDirectory;

try {
  await main();
} catch (error) {
  console.error(`\nDeployment stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}

async function main() {
  heading("Open Resend deployment preflight");
  console.log("No Cloudflare resources will be created or changed until every preflight check passes and you confirm the final plan.\n");

  requireCommand("node", ["--version"]);
  requireCommand("npm", ["--version"]);
  const terraform = findTerraform();
  requireCommand("npx", ["--no-install", "wrangler", "--version"]);

  const identity = jsonCommand("npx", ["--no-install", "wrangler", "whoami", "--json"]);
  if (!identity.loggedIn || !identity.accounts?.length) {
    fail("Wrangler is not logged in. Run `npx wrangler login`, then rerun this command.");
  }

  const account = await selectAccount(identity.accounts);
  const existingDeployment = readJsonIfPresent(deploymentPath);
  const existingTerraformVars = readTerraformVars(terraformVarsPath);

  console.log(`Cloudflare user: ${identity.email}`);
  console.log(`Cloudflare account: ${account.name} (${account.id})\n`);

  const workerName = await ask("Worker name", existingDeployment?.workerName ?? "open-resend");
  const adminHostname = normalizeHostname(await ask("Access-protected admin hostname", existingTerraformVars.admin_hostname ?? "resend.example.com"));
  const apiHostname = normalizeHostname(await ask("Public API hostname", existingDeployment?.apiHostname ?? "mail-api.example.com"));
  const existingDomains = Object.keys(existingDeployment?.unsubscribeHostnames ?? {});
  const sendingDomains = parseDomains(await ask("Enabled Email Sending domains (comma-separated)", existingDomains.join(", ") || "example.com"));

  const unsubscribeHostnames = {};
  for (const domain of sendingDomains) {
    const current = existingDeployment?.unsubscribeHostnames?.[domain] ?? `mail.${domain}`;
    unsubscribeHostnames[domain] = normalizeHostname(await ask(`Unsubscribe hostname for ${domain}`, current));
  }

  validateHostnames({ adminHostname, apiHostname, sendingDomains, unsubscribeHostnames });

  section("Checking Email Sending domains");
  const emailOutput = command("npx", ["--no-install", "wrangler", "email", "sending", "list"], { env: accountEnv(account.id) });
  const enabledDomains = parseEmailSendingDomains(emailOutput);
  const missingDomains = sendingDomains.filter((domain) => enabledDomains.get(domain)?.enabled !== true);
  if (missingDomains.length) {
    fail(`These domains are not enabled for Cloudflare Email Sending: ${missingDomains.join(", ")}. Enable them first at https://dash.cloudflare.com/?to=/:account/email-service/sending`);
  }
  for (const domain of sendingDomains) console.log(`✓ ${domain} is enabled`);

  section("Checking existing resources");
  const databaseName = existingDeployment?.d1DatabaseName ?? workerName;
  const databases = jsonCommand("npx", ["--no-install", "wrangler", "d1", "list", "--json"], { env: accountEnv(account.id) });
  const existingDatabase = databases.find((database) => database.name === databaseName);
  if (existingDeployment?.d1DatabaseId && !existingDatabase) {
    fail(`.deployment.json points to D1 ${existingDeployment.d1DatabaseId}, but ${databaseName} does not exist in this account.`);
  }
  if (existingDeployment?.d1DatabaseId && existingDatabase && existingDeployment.d1DatabaseId !== existingDatabase.uuid) {
    fail(`.deployment.json points to D1 ${existingDeployment.d1DatabaseId}, but ${databaseName} is ${existingDatabase.uuid} in this account.`);
  }

  const queueNames = {
    delivery: existingDeployment?.deliveryQueue ?? `${workerName}-deliveries`,
    deadLetter: existingDeployment?.deadLetterQueue ?? `${workerName}-deliveries-dlq`,
    emailEvents: existingDeployment?.emailEventsQueue ?? `${workerName}-email-events`,
  };
  const existingQueues = parseQueueNames(command("npx", ["--no-install", "wrangler", "queues", "list"], {
    env: accountEnv(account.id),
    quiet: true,
  }));

  console.log(existingDatabase ? `✓ D1 ${databaseName} already exists` : `• D1 ${databaseName} will be created`);
  for (const name of Object.values(queueNames)) {
    console.log(existingQueues.has(name) ? `✓ Queue ${name} already exists` : `• Queue ${name} will be created`);
  }

  section("Checking application");
  command("npm", ["run", "check"]);
  command("npm", ["test"]);
  console.log("✓ Application checks and tests passed");

  const token = process.env.CLOUDFLARE_API_TOKEN || await requestTerraformToken(account);
  await verifyToken(token);
  console.log("✓ Cloudflare API token is active");

  writeFileSync(terraformVarsPath, terraformVars({ accountId: account.id, adminHostname }), { mode: 0o600 });

  section("Validating Cloudflare Access plan");
  const terraformEnv = { ...process.env, CLOUDFLARE_API_TOKEN: token };
  command(terraform, ["-chdir=infra/access", "init"], { env: terraformEnv });
  temporaryDirectory = mkdtempSync(resolve(tmpdir(), "open-resend-deploy-"));
  const planPath = resolve(temporaryDirectory, "access.tfplan");
  command(terraform, ["-chdir=infra/access", "plan", `-out=${planPath}`], { env: terraformEnv });
  console.log("✓ Access token, Zero Trust organization, identity provider, and Terraform plan are valid");

  section("Deployment plan");
  console.log(`Account:              ${account.name} (${account.id})`);
  console.log(`Worker:               ${workerName}`);
  console.log(`Admin:                https://${adminHostname}`);
  console.log(`API:                  https://${apiHostname}`);
  for (const domain of sendingDomains) console.log(`Unsubscribe (${domain}): https://${unsubscribeHostnames[domain]}`);
  console.log(`D1:                   ${existingDatabase ? "reuse" : "create"} ${databaseName}`);
  for (const name of Object.values(queueNames)) console.log(`Queue:                ${existingQueues.has(name) ? "reuse" : "create"} ${name}`);
  console.log("Access:               apply the validated Terraform plan");
  console.log("Database:             apply all pending migrations");
  console.log("Email events:         create missing per-domain subscriptions");

  const confirmation = await ask("Type DEPLOY to continue", "");
  if (confirmation !== "DEPLOY") fail("Confirmation was not DEPLOY; no Cloudflare resources were changed.");

  section("Creating missing resources");
  const database = existingDatabase ?? createDatabase(databaseName, account.id);
  for (const name of Object.values(queueNames)) {
    if (!existingQueues.has(name)) command("npx", ["--no-install", "wrangler", "queues", "create", name], { env: accountEnv(account.id) });
  }

  const deployment = {
    workerName,
    apiHostname,
    unsubscribeHostnames,
    d1DatabaseId: database.uuid,
    d1DatabaseName: databaseName,
    environment: "production",
    deliveryQueue: queueNames.delivery,
    deadLetterQueue: queueNames.deadLetter,
    emailEventsQueue: queueNames.emailEvents,
  };
  writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 });

  section("Applying Cloudflare Access");
  command(terraform, ["-chdir=infra/access", "apply", "-auto-approve", planPath], { env: terraformEnv });

  section("Rendering and deploying Worker configuration");
  command(process.execPath, ["scripts/render-wrangler.mjs"], { env: { ...process.env, TERRAFORM_BIN: terraform } });
  command("npx", ["--no-install", "wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.deploy.jsonc"], {
    env: { ...accountEnv(account.id), CI: "true" },
  });
  command("npm", ["run", "build:assets"]);
  command("npx", ["--no-install", "wrangler", "deploy", "--config", "wrangler.deploy.jsonc"], { env: accountEnv(account.id) });

  section("Configuring Email Sending events");
  await ensureEmailEventSubscriptions({ accountId: account.id, domains: sendingDomains, enabledDomains, queue: queueNames.emailEvents });

  section("Verifying endpoints");
  await verifyEndpoints({ adminHostname, apiHostname, unsubscribeHostnames });

  heading("Deployment complete");
  console.log(`Admin: https://${adminHostname}`);
  console.log(`API:   https://${apiHostname}`);
  console.log("Next: sign into the admin site, register the enabled sending domains, add sender identities, and create an API key.");
}

function findTerraform() {
  for (const candidate of [process.env.TERRAFORM_BIN, "tofu", "terraform"].filter(Boolean)) {
    const result = spawnSync(candidate, ["version"], { cwd: root, stdio: "ignore" });
    if (result.status === 0) return candidate;
  }
  fail("OpenTofu or Terraform is required. On macOS run `brew install opentofu`, then rerun this command.");
}

function requireCommand(program, args) {
  const result = spawnSync(program, args, { cwd: root, stdio: "ignore" });
  if (result.status !== 0) fail(`${program} is required but unavailable.`);
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : ["inherit", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout && !options.quiet) process.stdout.write(stdout);
  if (stderr && !options.quiet) process.stderr.write(stderr);
  if (result.error) fail(`${program} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${program} ${args.join(" ")} exited with status ${result.status}.`);
  return stripAnsi(stdout);
}

function jsonCommand(program, args, options = {}) {
  const output = command(program, args, { ...options, quiet: true });
  try {
    const objectIndex = output.indexOf("{");
    const arrayIndex = output.indexOf("[");
    const indexes = [objectIndex, arrayIndex].filter((index) => index >= 0);
    if (!indexes.length) throw new Error("No JSON value found");
    return JSON.parse(output.slice(Math.min(...indexes)));
  } catch {
    fail(`Could not parse JSON from ${program} ${args.join(" ")}.`);
  }
}

async function selectAccount(accounts) {
  if (accounts.length === 1) return accounts[0];
  console.log("Available accounts:");
  for (const account of accounts) console.log(`- ${account.name}: ${account.id}`);
  const selected = await ask("Cloudflare account ID", "");
  const account = accounts.find(({ id }) => id === selected);
  if (!account) fail("The selected account ID is not available to the current Wrangler login.");
  return account;
}

async function ask(label, defaultValue) {
  if (!process.stdin.isTTY) {
    if (defaultValue) return defaultValue;
    fail(`${label} is required, but this terminal is not interactive.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  rl.close();
  return answer || defaultValue;
}

async function requestTerraformToken(account) {
  const tokenUrl = apiTokenTemplateUrl(account.id);
  console.log("\nA scoped Cloudflare API token is required only for the Zero Trust Access application.");
  console.log(`Opening a prefilled token for ${account.name}.`);
  console.log("Review the two permissions, continue to the summary, create the token, and copy its one-time value.");
  console.log(`If the browser does not open, use:\n${tokenUrl}\n`);
  openUrl(tokenUrl);
  return secretQuestion("Paste the token (input is hidden): ");
}

function apiTokenTemplateUrl(accountId) {
  const url = new URL("https://dash.cloudflare.com/profile/api-tokens");
  url.searchParams.set("permissionGroupKeys", JSON.stringify(tokenPermissions));
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("zoneId", "all");
  url.searchParams.set("name", "Open Resend deployment");
  return url.toString();
}

function secretQuestion(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) fail("Set CLOUDFLARE_API_TOKEN in the environment when running non-interactively.");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolvePromise, rejectPromise) => {
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          rejectPromise(new Error("Token entry cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          if (!value) rejectPromise(new Error("The Cloudflare API token cannot be empty."));
          else resolvePromise(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function verifyToken(token) {
  const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success || body.result?.status !== "active") fail("The Cloudflare API token is invalid or inactive.");
}

function openUrl(url) {
  const choices = process.platform === "darwin"
    ? [["open", [url]]]
    : process.platform === "win32"
      ? [["cmd", ["/c", "start", "", url]]]
      : [["xdg-open", [url]]];
  for (const [program, args] of choices) {
    const result = spawnSync(program, args, { cwd: root, stdio: "ignore" });
    if (result.status === 0) return;
  }
  console.log(`Open this URL manually: ${url}`);
}

function createDatabase(name, accountId) {
  command("npx", ["--no-install", "wrangler", "d1", "create", name], { env: accountEnv(accountId) });
  const databases = jsonCommand("npx", ["--no-install", "wrangler", "d1", "list", "--json"], { env: accountEnv(accountId) });
  const database = databases.find((item) => item.name === name);
  if (!database) fail(`D1 ${name} was created but could not be found afterward.`);
  return database;
}

async function ensureEmailEventSubscriptions({ accountId, domains, enabledDomains, queue }) {
  const existing = jsonCommand("npx", ["--no-install", "wrangler", "queues", "subscription", "list", queue, "--json"], { env: accountEnv(accountId) });
  for (const domain of domains) {
    const found = existing.some((subscription) => subscription.source?.type === "email.sending" && subscription.source?.domain === domain);
    if (found) {
      console.log(`✓ Event subscription for ${domain} already exists`);
      continue;
    }
    command("npx", [
      "--no-install", "wrangler", "queues", "subscription", "create", queue,
      "--source", "email.sending",
      "--events", emailEvents.join(","),
      "--name", `Open Resend — ${domain}`,
      "--zone-id", enabledDomains.get(domain).zoneId,
      "--domain", domain,
    ], { env: accountEnv(accountId) });
  }
}

async function verifyEndpoints({ adminHostname, apiHostname, unsubscribeHostnames }) {
  const admin = await fetch(`https://${adminHostname}/`, { redirect: "manual" });
  if (![302, 303, 401, 403].includes(admin.status)) fail(`Admin endpoint returned unexpected status ${admin.status}.`);
  console.log(`✓ Admin is protected (${admin.status})`);

  const api = await fetch(`https://${apiHostname}/segments`, { redirect: "manual" });
  if (api.status !== 401) fail(`API authentication check returned ${api.status}, expected 401.`);
  console.log("✓ API requires an API key (401)");

  for (const hostname of Object.values(unsubscribeHostnames)) {
    const response = await fetch(`https://${hostname}/unsubscribe/not-a-real-token`, { redirect: "manual" });
    if (![400, 404].includes(response.status)) fail(`${hostname} returned unexpected status ${response.status}.`);
    console.log(`✓ ${hostname} reaches the public unsubscribe handler`);
  }
}

function parseEmailSendingDomains(output) {
  const result = new Map();
  for (const line of output.split("\n")) {
    const cells = line.split("│").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length !== 4 || !/^[a-f0-9]{32}$/i.test(cells[3])) continue;
    result.set(normalizeHostname(cells[1]), { enabled: cells[2].toLowerCase() === "yes", zoneId: cells[3] });
  }
  return result;
}

function parseQueueNames(output) {
  const names = new Set();
  for (const line of output.split("\n")) {
    const cells = line.split("│").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length >= 2 && /^[a-f0-9]{32}$/i.test(cells[0])) names.add(cells[1]);
  }
  return names;
}

function parseDomains(value) {
  const domains = [...new Set(value.split(",").map((domain) => normalizeHostname(domain.trim())).filter(Boolean))];
  if (!domains.length) fail("At least one enabled Email Sending domain is required.");
  return domains;
}

function validateHostnames({ adminHostname, apiHostname, sendingDomains, unsubscribeHostnames }) {
  const hostnames = [adminHostname, apiHostname, ...Object.values(unsubscribeHostnames)];
  if (new Set(hostnames).size !== hostnames.length) fail("Admin, API, and unsubscribe hostnames must all be different.");
  for (const domain of sendingDomains) {
    const hostname = unsubscribeHostnames[domain];
    if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
      fail(`${hostname} must be ${domain} or a subdomain of it.`);
    }
  }
}

function normalizeHostname(value) {
  const hostname = value.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
    fail(`Invalid hostname: ${value}`);
  }
  return hostname;
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path} is not valid JSON: ${error.message}`);
  }
}

function readTerraformVars(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  return Object.fromEntries([...text.matchAll(/^([a-z_]+)\s*=\s*"([^"]*)"/gm)].map((match) => [match[1], match[2]]));
}

function terraformVars({ accountId, adminHostname }) {
  return `account_id         = "${accountId}"\nadmin_hostname     = "${adminHostname}"\nallowed_account_id = null\n\napplication_name = "Open Resend Admin"\nsession_duration = "24h"\n`;
}

function accountEnv(accountId) {
  return { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function heading(value) {
  console.log(`\n=== ${value} ===`);
}

function section(value) {
  console.log(`\n--- ${value} ---`);
}

function fail(message) {
  throw new Error(message);
}
