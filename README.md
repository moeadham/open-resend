# Cloudflare Mail

A small, Cloudflare-native mailing-list and campaign service with a Resend-compatible API. It supports named segments, contacts, multiple sending domains and senders, draft/immediate/scheduled broadcasts, per-list unsubscribe, delivery events, and a server-rendered administration site.

## Architecture

- One Worker dispatches by hostname: `ADMIN_HOSTNAME` serves the browser UI and `API_HOSTNAME` serves the API and unsubscribe pages.
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

1. Create D1 and replace the zero UUID in `wrangler.jsonc` with the returned database ID:

   ```bash
   npx wrangler d1 create cloudflare-resend
   npx wrangler d1 migrations apply cloudflare-resend --remote
   ```

2. Create the delivery, dead-letter, and Email Service event queues:

   ```bash
   npx wrangler queues create cloudflare-resend-deliveries
   npx wrangler queues create cloudflare-resend-deliveries-dlq
   npx wrangler queues create cloudflare-resend-email-events
   ```

3. Onboard every sending domain in **Cloudflare Dashboard → Compute & AI → Email Service → Email Sending**. Domain onboarding remains deliberately outside this application.

4. For every sending domain, create an Email Sending event subscription targeting `cloudflare-resend-email-events`. Subscribe to delivered, deferred, bounced, failed, rejected, and complained events.

5. Add both custom hostnames to the Worker. Set the variables in `wrangler.jsonc` to the real hostnames and set `PUBLIC_BASE_URL` to the HTTPS API hostname.

6. In **Zero Trust → Access controls → Applications**, create a self-hosted application covering the entire admin hostname, for example `mail-admin.example.com/*`. Add an explicit Allow policy for the intended administrators and leave all other identities denied.

7. Copy the Access Application Audience tag to `ACCESS_AUD`. Set `ACCESS_TEAM_DOMAIN` to the team hostname, such as `company.cloudflareaccess.com` or `https://company.cloudflareaccess.com`.

8. Build and deploy:

   ```bash
   npm run check
   npm test
   npm run deploy:dry
   npm run deploy
   ```

After signing into the admin hostname through Access, register the already-onboarded domains and sender addresses, then create the first API key from the **API keys** page.

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
