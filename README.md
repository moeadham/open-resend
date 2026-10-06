# Cloudflare Mail

A small, Cloudflare-native mailing-list and campaign service with a Resend-compatible API. It supports named segments, contacts, multiple sending domains and senders, draft/immediate/scheduled broadcasts, per-list unsubscribe, delivery events, and a server-rendered administration site.

## Architecture

- One Worker dispatches by hostname: `ADMIN_HOSTNAME` serves the browser UI, `API_HOSTNAME` serves the Resend-compatible API, and deployment-configured unsubscribe hostnames serve public unsubscribe pages.
- The complete admin hostname is protected by a Cloudflare Zero Trust Access self-hosted application. The Worker also verifies the Access JWT.
- D1 stores application data, Queues fan out one message per recipient, and one Durable Object alarm is used per scheduled broadcast.
- Cloudflare Email Service is the only outbound transport.
- The admin interface is server-rendered Hono JSX. Quill is bundled locally; no CDN scripts or application passwords are used.

## Local development

Requirements: Node.js 22+, a Cloudflare account, and Wrangler authentication.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run build:assets
npx wrangler d1 migrations apply cloudflare-resend --local
npm run dev
```

The local admin bypass works only when all three conditions hold:

- The request hostname is `localhost`, `127.0.0.1`, or `::1`.
- `ENVIRONMENT` is not `production`.
- `ALLOW_LOCAL_ADMIN=true` is set in `.dev.vars`.

The bypass cannot authenticate a non-local hostname or a production environment.

## Cloudflare provisioning

Terraform owns only the Zero Trust Access application and policy. Wrangler owns the Worker, custom domains, and bindings. This separation prevents the two tools from changing the same Cloudflare resources.

Before the first deployment, activate a Zero Trust plan for the Cloudflare account and configure Cloudflare as its account-member identity provider. New Zero Trust organizations include this identity provider by default. Terraform requires exactly one Cloudflare identity provider, restricts the application to it, and redirects authentication directly to it. The default policy admits members of the deploying Cloudflare account; set `allowed_account_id` to authorize members of a different account.

### Create the Terraform API token

In **Cloudflare Dashboard → My Profile → API Tokens**, select **Create Token**, then **Create Custom Token**.

![Cloudflare custom API token form](docs/images/cloudflare-token/01-custom-token-form.jpg)

Name the token `cloudflare-resend-terraform` and add these account permissions:

- **Access: Apps and Policies → Edit**
- **Access: Organizations, Identity Providers, and Groups → Read**

Under **Account Resources**, choose **Include → Specific account** and select only the account where this application will be deployed. An IP restriction or short TTL is optional, but a short TTL is sensible for a one-off manual deployment.

![Scoped Access permissions and account resource](docs/images/cloudflare-token/02-scoped-permissions.jpg)

Select **Continue to summary** and verify that the summary contains only the two permissions and the intended account.

![Cloudflare API token summary](docs/images/cloudflare-token/03-token-summary.jpg)

Select **Create Token**, copy the token from the one-time display, and export it for Terraform. The screenshots intentionally stop before the secret is shown. Never commit the token, paste it into an issue, or include it in a screenshot.

```bash
export CLOUDFLARE_API_TOKEN="paste-token-here"
```

### Provision and deploy

1. Confirm that the API token has these account permissions:

   - Access: Apps and Policies Edit
   - Access: Organizations, Identity Providers, and Groups Read

2. Configure and apply the Access infrastructure:

   ```bash
   cp infra/access/terraform.tfvars.example infra/access/terraform.tfvars
   # Fill in account_id and admin_hostname.
   terraform -chdir=infra/access init
   terraform -chdir=infra/access apply
   ```

   Terraform protects the complete admin hostname, attaches one Allow policy for Cloudflare account members, and outputs the application audience and Zero Trust team domain consumed by the Worker. Access denies identities that do not match an Allow policy by default.

3. Create D1 and retain the returned database ID:

   ```bash
   npx wrangler d1 create cloudflare-resend
   ```

4. Create the delivery, dead-letter, and Email Service event queues:

   ```bash
   npx wrangler queues create cloudflare-resend-deliveries
   npx wrangler queues create cloudflare-resend-deliveries-dlq
   npx wrangler queues create cloudflare-resend-email-events
   ```

5. Copy `.deployment.example.json` to `.deployment.json`, enter the API hostname and D1 database ID, and map each sending domain to its unsubscribe hostname:

   ```json
   {
     "apiHostname": "mail-api.example.com",
     "unsubscribeHostnames": {
       "example.com": "mail.example.com",
       "another-domain.com": "mail.another-domain.com"
     }
   }
   ```

   The keys must match the sending domains registered in the admin. Every value becomes a Wrangler-managed Worker Custom Domain, and campaigns select the hostname associated with their sender domain. These are configured in the deployment file as requested, but Cloudflare creates the DNS records directly; do not create conflicting CNAME records manually.

   Render the deploy-only Wrangler configuration and apply D1 migrations:

   ```bash
   cp .deployment.example.json .deployment.json
   npm run config:deploy
   npx wrangler d1 migrations apply cloudflare-resend --remote --config wrangler.deploy.jsonc
   ```

   `.deployment.json`, Terraform state, `terraform.tfvars`, and `wrangler.deploy.jsonc` are ignored by Git. The checked-in `wrangler.jsonc` contains only local-development defaults.

6. Onboard every sending domain in **Cloudflare Dashboard → Compute & AI → Email Service → Email Sending**. Domain onboarding remains deliberately outside this application.

7. For every sending domain, create an Email Sending event subscription targeting `cloudflare-resend-email-events`. Subscribe to delivered, deferred, bounced, failed, rejected, and complained events.

8. Build and deploy. The deploy command regenerates `wrangler.deploy.jsonc` from Terraform outputs before invoking Wrangler:

   ```bash
   npm run check
   npm test
   npm run deploy:dry
   npm run deploy
   ```

After signing into the admin hostname through Access, register the already-onboarded domains and sender addresses, then create the first API key from the **API keys** page.

For shared or automated deployments, store Terraform state in a remote backend with locking rather than committing local state. A manually created Access application for the same hostname must be removed before applying this configuration; the project intentionally supports one Terraform-owned installation path rather than migration of dashboard-managed resources.

## Resend SDK

The supported v1 surface is Segments, Contacts, contact/segment membership, and Broadcasts. Configure the official SDK with this service's base URL:

```ts
import { Resend } from "resend";

const resend = new Resend(process.env.MAIL_API_KEY, {
  baseUrl: "https://mail-api.example.com",
});

const segment = await resend.segments.create({ name: "Product updates" });

await resend.contacts.create({
  email: "reader@example.net",
  segments: [{ id: segment.data!.id }],
});

await resend.broadcasts.create({
  name: "October update",
  segmentId: segment.data!.id,
  from: "Example News <news@example.com>",
  subject: "Hello",
  html: "<p>Hello!</p>",
  send: true,
});
```

API keys use a `re_` prefix, are displayed once, and are stored only as SHA-256 hashes. `Idempotency-Key` is supported on broadcast mutations for 24 hours. Scheduling accepts ISO 8601 timestamps only.

Not implemented in v1: deprecated Audiences, transactional `/emails`, attachments, templates, broadcast duplication, recipient export, open/click tracking, public signup, inbound mail, and automations.

## Unsubscribe and delivery behavior

- Every campaign gets text and HTML footers containing the selected sender's physical address and a list-specific unsubscribe link.
- Each campaign uses the unsubscribe hostname mapped to its sender's domain in `.deployment.json`. Sending and test-send preflight fail if that mapping is missing.
- Each email includes RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
- Browser `GET` displays confirmation without changing state. `POST` performs an idempotent list-level unsubscribe.
- An authenticated segment-add operation explicitly re-subscribes that membership.
- Queue messages contain only a delivery ID. State and cancellation are rechecked immediately before sending.
- Queue delivery is at least once. Atomic delivery claims remove normal duplicates, but a crash after Email Service accepts a message and before D1 records that result can still cause a rare duplicate.

## Verification

```bash
npm run check       # assets, generated bindings, strict TypeScript
npm test            # Worker-runtime tests and official Resend SDK contract tests
npm run deploy:dry  # Wrangler bundle and binding validation
npm audit --omit=dev
```

The Worker-runtime suite applies the real D1 migration and exercises API authentication, the pinned official Resend SDK, idempotent Broadcast creation, Access JWT validation, scanner-safe unsubscribe behavior, and generated MIME headers/body ordering. Staging delivery and event-subscription checks still require provisioned Cloudflare domains and queues.
