import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentPath = resolve(root, ".deployment.json");
const secretsPath = resolve(root, ".open-resend.secrets.json");
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
const operationName = process.argv.includes("--teardown") ? "Teardown" : "Deployment";
const assumeYes = process.argv.includes("-y") || process.argv.includes("--yes");
const forceConfigure = process.argv.includes("--configure");

try {
  if (process.argv.includes("--teardown")) await teardown();
  else await main();
} catch (error) {
  console.error(`\n${operationName} stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}

async function teardown() {
  heading("Open Resend teardown preflight");
  console.log("This removes only the resources recorded for this installation. Email Sending and its onboarded domains are never disabled.\n");
  if (!assumeYes && !process.stdin.isTTY) {
    fail("Interactive teardown requires a terminal. Rerun with -y or --yes only after reviewing the deletion plan.");
  }

  requireCommand("node", ["--version"]);
  requireCommand("npm", ["--version"]);
  requireCommand("npx", ["--no-install", "wrangler", "--version"]);
  const terraform = findTerraform();

  const deployment = readJsonIfPresent(deploymentPath);
  if (!deployment) fail(`No ${deploymentPath} exists, so teardown cannot safely identify this installation.`);
  const terraformVars = readTerraformVars(terraformVarsPath);
  const accountId = deployment.accountId ?? terraformVars.account_id;
  const adminHostname = deployment.adminHostname ?? terraformVars.admin_hostname;
  if (!accountId || !adminHostname) fail(`Missing accountId or adminHostname in ${deploymentPath}.`);
  writeTerraformVars({ accountId, adminHostname });
  const terraformStatePath = resolve(root, "infra/access/terraform.tfstate");
  if (!existsSync(terraformStatePath)) {
    fail("Terraform state is missing. Refusing to guess which Cloudflare Access resources belong to this installation.");
  }

  const identity = jsonCommand("npx", ["--no-install", "wrangler", "whoami", "--json"]);
  if (!identity.loggedIn || !identity.accounts?.length) {
    fail("Wrangler is not logged in. Run `npx wrangler login`, then rerun this command.");
  }
  const account = identity.accounts.find(({ id }) => id === accountId);
  if (!account) fail(`Wrangler is not logged into the deployment account ${accountId}.`);
  const cloudflareEnv = accountEnv(account.id);

  section("Inventorying recorded resources");
  const databases = jsonCommand("npx", ["--no-install", "wrangler", "d1", "list", "--json"], { env: cloudflareEnv });
  const database = databases.find(({ uuid }) => uuid === deployment.d1DatabaseId);
  if (database && database.name !== deployment.d1DatabaseName) {
    fail(`D1 ${deployment.d1DatabaseId} is now named ${database.name}; expected ${deployment.d1DatabaseName}.`);
  }

  const queueNames = [deployment.deliveryQueue, deployment.deadLetterQueue, deployment.emailEventsQueue];
  const existingQueues = parseQueueNames(command("npx", ["--no-install", "wrangler", "queues", "list"], {
    env: cloudflareEnv,
    quiet: true,
  }));
  const workerQueueConsumers = [];
  for (const queueName of queueNames) {
    if (!existingQueues.has(queueName)) continue;
    const consumers = jsonCommand("npx", ["--no-install", "wrangler", "queues", "consumer", "list", queueName, "--json"], { env: cloudflareEnv });
    if (consumers.some((consumer) => consumer.type === "worker" && consumer.script === deployment.workerName)) {
      workerQueueConsumers.push(queueName);
    }
  }
  const subscriptions = existingQueues.has(deployment.emailEventsQueue)
    ? jsonCommand("npx", ["--no-install", "wrangler", "queues", "subscription", "list", deployment.emailEventsQueue, "--json"], { env: cloudflareEnv })
    : [];
  const sendingDomains = Object.keys(deployment.unsubscribeHostnames ?? {});
  const managedSubscriptions = subscriptions.filter((subscription) =>
    subscription.source?.type === "email.sending"
    && sendingDomains.includes(subscription.source?.domain)
    && subscription.name === `Open Resend — ${subscription.source.domain}`
  );
  const workerExists = remoteWorkerExists(deployment.workerName, account.id);

  const token = await getTerraformToken(account);
  const terraformEnv = { ...process.env, CLOUDFLARE_API_TOKEN: token };
  command(terraform, ["-chdir=infra/access", "init"], { env: terraformEnv });
  const accessResources = command(terraform, ["-chdir=infra/access", "state", "list"], { env: terraformEnv, quiet: true })
    .split("\n").map((line) => line.trim()).filter(Boolean);
  temporaryDirectory = mkdtempSync(resolve(tmpdir(), "open-resend-teardown-"));
  const planPath = resolve(temporaryDirectory, "access-destroy.tfplan");
  command(terraform, ["-chdir=infra/access", "plan", "-destroy", `-out=${planPath}`], { env: terraformEnv });

  section("Permanent teardown plan");
  console.log(`Account:              ${account.name} (${account.id})`);
  console.log(`Worker:               ${workerExists ? "delete" : "already absent"} ${deployment.workerName}`);
  for (const queueName of workerQueueConsumers) console.log(`Queue consumer:       remove ${deployment.workerName} from ${queueName} before Worker deletion`);
  console.log(`Access:               destroy ${accessResources.length} Terraform-managed resource(s) for https://${adminHostname}`);
  console.log(`Event subscriptions:  delete ${managedSubscriptions.length} Open Resend subscription(s)`);
  for (const name of queueNames) console.log(`Queue:                ${existingQueues.has(name) ? "delete" : "already absent"} ${name}`);
  console.log(`D1 and all its data:  ${database ? "DELETE PERMANENTLY" : "already absent"} ${deployment.d1DatabaseName} (${deployment.d1DatabaseId})`);
  for (const domain of sendingDomains) console.log(`Email Sending:        KEEP ENABLED ${domain}`);

  console.log(assumeYes
    ? "\n-y/--yes supplied: every listed deletion is approved."
    : "\nYou will be asked about each deletion. Press Enter or answer n to keep an item.");

  const retained = [];

  section("Deleting Email Sending event subscriptions");
  for (const subscription of managedSubscriptions) {
    const label = `Email Sending event subscription for ${subscription.source.domain} (${subscription.id})`;
    if (await confirmDeletion(label)) {
      command("npx", ["--no-install", "wrangler", "queues", "subscription", "delete", deployment.emailEventsQueue, "--id", subscription.id, "--force"], { env: cloudflareEnv });
    } else {
      retain(retained, label);
    }
  }

  let workerRetained = false;
  if (workerExists) {
    const consumerSummary = workerQueueConsumers.length
      ? `, its custom-domain routes, and ${workerQueueConsumers.length} queue-consumer registration(s)`
      : " and its custom-domain routes";
    const label = `Worker ${deployment.workerName}${consumerSummary}`;
    if (await confirmDeletion(label)) {
      if (workerQueueConsumers.length) {
        section("Removing Worker queue consumers");
        for (const queueName of workerQueueConsumers) {
          command("npx", ["--no-install", "wrangler", "queues", "consumer", "remove", queueName, deployment.workerName], { env: cloudflareEnv });
        }
      }
      section("Deleting Worker and its custom domains");
      command("npx", ["--no-install", "wrangler", "delete", deployment.workerName, "--force"], { env: cloudflareEnv });
    } else {
      workerRetained = true;
      retain(retained, label);
    }
  }

  if (accessResources.length) {
    const label = `Cloudflare Access configuration for https://${adminHostname} (${accessResources.length} Terraform resource(s))`;
    if (workerRetained) {
      retain(retained, label, "the Worker still needs Access protection");
    } else if (await confirmDeletion(label)) {
      section("Destroying Cloudflare Access application and policy");
      command(terraform, ["-chdir=infra/access", "apply", "-auto-approve", planPath], { env: terraformEnv });
    } else {
      retain(retained, label);
    }
  }

  section("Deleting queues");
  for (const name of queueNames) {
    if (!existingQueues.has(name)) continue;
    const label = `queue ${name}`;
    const retainedEmailSubscription = name === deployment.emailEventsQueue
      && managedSubscriptions.some((subscription) => retained.includes(`Email Sending event subscription for ${subscription.source.domain} (${subscription.id})`));
    if (workerRetained) {
      retain(retained, label, "the retained Worker is bound to it");
    } else if (retainedEmailSubscription) {
      retain(retained, label, "an Email Sending event subscription still targets it");
    } else if (await confirmDeletion(label)) {
      command("npx", ["--no-install", "wrangler", "queues", "delete", name], { env: { ...cloudflareEnv, CI: "true" } });
    } else {
      retain(retained, label);
    }
  }

  if (database) {
    const label = `D1 database ${deployment.d1DatabaseName} (${deployment.d1DatabaseId}) and ALL of its data`;
    if (workerRetained) {
      retain(retained, label, "the retained Worker is bound to it");
    } else if (await confirmDeletion(label)) {
      section("Deleting D1 database and all data");
      command("npx", ["--no-install", "wrangler", "d1", "delete", deployment.d1DatabaseId, "--skip-confirmation"], { env: cloudflareEnv });
    } else {
      retain(retained, label);
    }
  }

  const generatedPaths = [deploymentPath, resolve(root, "wrangler.deploy.jsonc"), terraformVarsPath, terraformStatePath, `${terraformStatePath}.backup`];
  const existingGeneratedPaths = generatedPaths.filter(existsSync);
  if (retained.length) {
    retain(retained, "local generated deployment state", "it is required to safely finish teardown later");
  } else if (existingGeneratedPaths.length && await confirmDeletion(`local generated deployment state (${existingGeneratedPaths.length} file(s))`)) {
    for (const path of existingGeneratedPaths) rmSync(path, { force: true });
  } else if (existingGeneratedPaths.length) {
    retain(retained, "local generated deployment state");
  }

  heading(retained.length ? "Teardown finished with retained items" : "Teardown complete");
  if (retained.length) {
    console.log("The following items were kept:");
    for (const label of retained) console.log(`- ${label}`);
    console.log("\nRun teardown again when you are ready to remove the remaining items.");
  } else {
    console.log("The Worker, Access configuration, event subscriptions, queues, D1 database, and local deployment state were removed.");
  }
  console.log(`Email Sending remains enabled for: ${sendingDomains.join(", ")}`);
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

  const existingDeployment = readJsonIfPresent(deploymentPath);
  const existingTerraformVars = readTerraformVars(terraformVarsPath);
  const configuredAccountId = existingDeployment?.accountId ?? existingTerraformVars.account_id;
  const hasSavedConfiguration = isCompleteDeploymentConfig(existingDeployment, configuredAccountId);
  const configure = forceConfigure || !hasSavedConfiguration;
  if (!configure && !process.stdin.isTTY && !assumeYes) {
    fail("Non-interactive deployment requires -y or --yes.");
  }
  if (configure && !process.stdin.isTTY) {
    fail(`Deployment configuration is incomplete. Run \`npm run deploy${forceConfigure ? " -- --configure" : ""}\` in an interactive terminal first.`);
  }

  const account = configure
    ? await selectAccount(identity.accounts, configuredAccountId)
    : identity.accounts.find(({ id }) => id === configuredAccountId);
  if (!account) fail(`Wrangler is not logged into the configured deployment account ${configuredAccountId}.`);

  console.log(`Cloudflare user: ${identity.email}`);
  console.log(`Cloudflare account: ${account.name} (${account.id})\n`);

  let workerName;
  let adminHostname;
  let apiHostname;
  let sendingDomains;
  let unsubscribeHostnames;
  if (configure) {
    console.log(forceConfigure ? "Updating saved deployment configuration.\n" : "No complete deployment configuration was found. Starting first-time setup.\n");
    workerName = await ask("Worker name", existingDeployment?.workerName ?? "open-resend");
    adminHostname = normalizeHostname(await ask("Access-protected admin hostname", existingDeployment?.adminHostname ?? existingTerraformVars.admin_hostname ?? "resend.example.com"));
    apiHostname = normalizeHostname(await ask("Public API hostname", existingDeployment?.apiHostname ?? "mail-api.example.com"));
    const existingDomains = Object.keys(existingDeployment?.unsubscribeHostnames ?? {});
    sendingDomains = parseDomains(await ask("Enabled Email Sending domains (comma-separated)", existingDomains.join(", ") || "example.com"));
    unsubscribeHostnames = {};
    for (const domain of sendingDomains) {
      const current = existingDeployment?.unsubscribeHostnames?.[domain] ?? `mail.${domain}`;
      unsubscribeHostnames[domain] = normalizeHostname(await ask(`Unsubscribe hostname for ${domain}`, current));
    }
  } else {
    workerName = existingDeployment.workerName;
    adminHostname = normalizeHostname(existingDeployment.adminHostname);
    apiHostname = normalizeHostname(existingDeployment.apiHostname);
    unsubscribeHostnames = Object.fromEntries(Object.entries(existingDeployment.unsubscribeHostnames)
      .map(([domain, hostname]) => [normalizeHostname(domain), normalizeHostname(hostname)]));
    sendingDomains = Object.keys(unsubscribeHostnames);
    console.log(`Using saved configuration from ${deploymentPath}. Pass --configure to change it.\n`);
  }

  validateHostnames({ adminHostname, apiHostname, sendingDomains, unsubscribeHostnames });

  section("Checking Email Sending domains");
  const emailOutput = command("npx", ["--no-install", "wrangler", "email", "sending", "list"], { env: accountEnv(account.id) });
  const enabledDomains = parseEmailSendingDomains(emailOutput);
  const missingDomains = sendingDomains.filter((domain) => enabledDomains.get(domain)?.enabled !== true);
  if (missingDomains.length) {
    fail(`These domains are not enabled for Cloudflare Email Sending: ${missingDomains.join(", ")}. Enable them first at https://dash.cloudflare.com/?to=/:account/email-service/sending`);
  }
  for (const domain of sendingDomains) {
    enabledDomains.get(domain).zoneId = resolveEmailSendingZoneId(domain, account.id);
    console.log(`✓ ${domain} is enabled`);
  }

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

  const token = await getTerraformToken(account);
  console.log("✓ Cloudflare API token is active");

  writeTerraformVars({ accountId: account.id, adminHostname });

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

  if (assumeYes) {
    console.log("Deployment approved by -y/--yes.");
  } else if (configure) {
    const confirmation = await ask("Type DEPLOY to continue", "");
    if (confirmation !== "DEPLOY") {
      heading("Deployment cancelled");
      console.log("No Cloudflare resources were changed.");
      return;
    }
  } else {
    const confirmation = (await ask("Deploy this update?", "N")).toLowerCase();
    if (confirmation !== "y" && confirmation !== "yes") {
      heading("Deployment cancelled");
      console.log("No Cloudflare resources were changed.");
      return;
    }
  }

  section("Creating missing resources");
  const database = existingDatabase ?? createDatabase(databaseName, account.id);
  for (const name of Object.values(queueNames)) {
    if (!existingQueues.has(name)) command("npx", ["--no-install", "wrangler", "queues", "create", name], { env: accountEnv(account.id) });
  }

  const deployment = {
    accountId: account.id,
    workerName,
    adminHostname,
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
  const verificationWarnings = await verifyEndpoints({ adminHostname, apiHostname, unsubscribeHostnames });

  heading(verificationWarnings.length ? "Deployment complete — endpoint verification pending" : "Deployment complete");
  console.log(`Admin: https://${adminHostname}`);
  console.log(`API:   https://${apiHostname}`);
  if (verificationWarnings.length) {
    console.log("\nCloudflare accepted and deployed every resource, but these endpoint checks did not pass before the verification window ended:");
    for (const warning of verificationWarnings) console.log(`- ${warning}`);
    console.log("This is commonly caused by DNS or TLS propagation immediately after creating custom domains. The deployment does not need to be repeated; check these URLs again in a few minutes.");
  }
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

async function selectAccount(accounts, preferredAccountId) {
  if (accounts.length === 1) return accounts[0];
  console.log("Available accounts:");
  for (const account of accounts) console.log(`- ${account.name}: ${account.id}`);
  const preferred = accounts.some(({ id }) => id === preferredAccountId) ? preferredAccountId : "";
  const selected = await ask("Cloudflare account ID", preferred);
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

async function confirmDeletion(label) {
  if (assumeYes) {
    console.log(`Delete ${label}? yes (-y)`);
    return true;
  }
  const answer = (await ask(`Delete ${label}?`, "N")).toLowerCase();
  return answer === "y" || answer === "yes";
}

function retain(retained, label, reason) {
  retained.push(label);
  console.log(`Keep ${label}${reason ? ` — ${reason}` : ""}.`);
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

async function getTerraformToken(account) {
  const environmentToken = process.env.CLOUDFLARE_API_TOKEN;
  if (environmentToken) {
    await verifyToken(environmentToken);
    console.log("✓ Using Cloudflare API token from CLOUDFLARE_API_TOKEN");
    return environmentToken;
  }

  const secrets = readJsonIfPresent(secretsPath) ?? {};
  const savedToken = secrets.cloudflareApiTokens?.[account.id];
  if (typeof savedToken === "string" && savedToken) {
    try {
      await verifyToken(savedToken);
      console.log(`✓ Using saved Cloudflare API token from ${secretsPath}`);
      return savedToken;
    } catch (error) {
      if (error.message !== "The Cloudflare API token is invalid or inactive.") throw error;
      console.log(`The saved Cloudflare API token for ${account.name} is no longer active. A replacement is required.`);
    }
  }

  const token = await requestTerraformToken(account);
  await verifyToken(token);
  const cloudflareApiTokens = {
    ...(secrets.cloudflareApiTokens ?? {}),
    [account.id]: token,
  };
  writeFileSync(secretsPath, `${JSON.stringify({ ...secrets, cloudflareApiTokens }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(secretsPath, 0o600);
  console.log(`✓ Saved Cloudflare API token to ${secretsPath} (mode 0600)`);
  return token;
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

function remoteWorkerExists(name, accountId) {
  const result = spawnSync("npx", ["--no-install", "wrangler", "deployments", "list", "--name", name], {
    cwd: root,
    env: accountEnv(accountId),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.status === 0) return true;
  if (output.includes("does not exist on your account") || output.includes("code: 10007")) return false;
  fail(`Could not determine whether Worker ${name} exists.`);
}

function resolveEmailSendingZoneId(domain, accountId) {
  // The Email Sending list table exposes the sending-domain tag, not the DNS
  // zone ID required by Queue event subscriptions. Let Wrangler perform its
  // authenticated zone lookup and read the resolved ID from its debug request.
  const result = spawnSync("npx", ["--no-install", "wrangler", "email", "sending", "list", domain], {
    cwd: root,
    env: { ...accountEnv(accountId), WRANGLER_LOG: "debug" },
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  const output = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.error) fail(`Could not look up the DNS zone for ${domain}: ${result.error.message}`);
  if (result.status !== 0) fail(`Could not look up the DNS zone for ${domain}.`);
  const match = output.match(/\/zones\/([a-f0-9]{32})\/email\/sending\/subdomains/i);
  if (!match) fail(`Wrangler did not return the DNS zone ID for ${domain}.`);
  return match[1];
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
  const checks = [
    {
      label: "Admin protection",
      url: `https://${adminHostname}/`,
      expected: [302, 303, 401, 403],
      success: (status) => `✓ Admin is protected (${status})`,
    },
    {
      label: "API authentication",
      url: `https://${apiHostname}/segments`,
      expected: [401],
      success: () => "✓ API requires an API key (401)",
    },
    ...Object.values(unsubscribeHostnames).map((hostname) => ({
      label: `Unsubscribe handler ${hostname}`,
      url: `https://${hostname}/unsubscribe/not-a-real-token`,
      expected: [400, 404],
      success: () => `✓ ${hostname} reaches the public unsubscribe handler`,
    })),
  ];
  const pending = new Map(checks.map((check) => [check.label, { check, result: "not checked" }]));
  const retryDelays = [0, 2_000, 4_000, 8_000, 12_000, 15_000];

  for (let attempt = 0; attempt < retryDelays.length && pending.size; attempt += 1) {
    if (retryDelays[attempt]) {
      console.log(`Waiting ${retryDelays[attempt] / 1_000}s for ${pending.size} endpoint(s) to become ready...`);
      await delay(retryDelays[attempt]);
    }
    await Promise.all([...pending.values()].map(async ({ check }) => {
      try {
        const response = await fetch(check.url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
        if (check.expected.includes(response.status)) {
          console.log(check.success(response.status));
          pending.delete(check.label);
        } else {
          pending.set(check.label, { check, result: `returned ${response.status}; expected ${check.expected.join(" or ")}` });
        }
      } catch (error) {
        pending.set(check.label, { check, result: error.cause?.message ?? error.message });
      }
    }));
  }

  return [...pending.values()].map(({ check, result }) => `${check.label} at ${check.url}: ${result}`);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
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

function isCompleteDeploymentConfig(deployment, accountId) {
  if (!deployment || !/^[a-f0-9]{32}$/i.test(accountId ?? "")) return false;
  const requiredStrings = [
    deployment.workerName,
    deployment.adminHostname,
    deployment.apiHostname,
    deployment.d1DatabaseName,
    deployment.deliveryQueue,
    deployment.deadLetterQueue,
    deployment.emailEventsQueue,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || !value.trim())) return false;
  if (!/^[a-f0-9-]{36}$/i.test(deployment.d1DatabaseId ?? "")) return false;
  const unsubscribeEntries = Object.entries(deployment.unsubscribeHostnames ?? {});
  return unsubscribeEntries.length > 0 && unsubscribeEntries.every(([domain, hostname]) => domain && typeof hostname === "string" && hostname);
}

function writeTerraformVars({ accountId, adminHostname }) {
  writeFileSync(terraformVarsPath, terraformVars({ accountId, adminHostname }), { mode: 0o600 });
  chmodSync(terraformVarsPath, 0o600);
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
