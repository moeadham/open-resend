# Open Resend agent guide

This repository is a self-hosted Resend-compatible backend on Cloudflare. Preserve the supported Resend wire contract: applications should switch by changing the API key, webhook signing secret, and SDK base URL, not by adding provider-specific adapters.

## Safety and remote changes

- Local inspection, builds, tests, and dry runs are safe defaults. Do not deploy, migrate DNS/MX, change Email Routing, create/delete Cloudflare resources, rotate secrets, push commits, or touch another repository unless the user explicitly requests that action.
- Before any remote mutation, state the exact Cloudflare account name/ID, Worker name, hostnames/domains, resources, and command or UI action that will change. Wait for explicit confirmation when the requested action is ambiguous.
- `npm run deploy` and `npm run teardown` change remote services. Never use `--yes`/`-y` unless the user explicitly asks for an unattended operation after seeing the target and plan.
- This repository deploys Open Resend only. Do not edit or deploy fwd2cal, Firebase, or another consumer application from an Open Resend request.
- Preserve unrelated and uncommitted work. Never replace `.deployment.json`, Terraform/OpenTofu state, `terraform.tfvars`, `.open-resend.secrets.json`, or a Wrangler profile with values from another account.
- Receiving-domain **Migrate now** deliberately changes MX/SPF/DKIM and removes the selected domain's previous-provider MX records after a preview and confirmation. Never invoke it as a diagnostic step.

## Source of truth

- `wrangler.jsonc` is the local-development baseline. `scripts/render-wrangler.mjs` combines it with `.deployment.json` and `infra/access` outputs to create the ignored `wrangler.deploy.jsonc`.
- `scripts/deploy.mjs` is the guided production workflow. Keep its preflight read-only until the final deployment confirmation.
- D1 schema changes belong in ordered files under `migrations/`; do not rewrite applied migrations.
- Resend compatibility is defined by the public request/response/error shapes and official SDK contract tests, not by internal database shapes or admin UI behavior.
- The root README documents supported APIs, deployment, receiving, retention, and known gaps. Update it whenever those contracts change. Keep `infra/access/README.md` synchronized with the Terraform/OpenTofu module.

## Cloudflare resources

- Terraform/OpenTofu owns only the Zero Trust Access application and policy for the admin hostname.
- Wrangler owns the Worker, custom domains, D1, R2, Queues, cron, Email Sending binding, secrets, and Email Sending event subscriptions.
- D1 stores application state. The private R2 bucket stores incoming raw MIME and attachment bytes. Separate Queues handle delivery, provider events, dead letters, and webhooks.
- Cloudflare Email Service is the outbound transport. Cloudflare Email Routing invokes the Worker's email handler for inbound mail.
- Teardown retains R2 and refuses to remove a Worker while recorded receiving rules still target it. Do not weaken those safeguards.

## Credentials

Never print, log, commit, paste into test snapshots, or pass secret values as command arguments. `.open-resend.secrets.json` is git-ignored, mode `0600`, and keyed by Cloudflare account ID.

| Environment variable | Required permissions | Saved map |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Access: Apps and Policies Edit; Access: Organizations, Identity Providers, and Groups Read | `cloudflareApiTokens` |
| `CLOUDFLARE_EMAIL_DISCOVERY_TOKEN` | Email Sending Edit; Zone Read | `emailDiscoveryTokens` |
| `CLOUDFLARE_EMAIL_ROUTING_TOKEN` | Zone Read; DNS Edit; Zone Settings Edit; Email Routing Rules Edit | `emailRoutingTokens` |
| `CLOUDFLARE_IMAGES_TOKEN` (optional) | Cloudflare Images Edit | `imagesTokens` |

Wrangler OAuth is separate and provisions the Worker-side resources. Environment variables override saved tokens and must not be persisted. Token templates must remain restricted to the selected account; receiving currently covers all zones in that account so the admin can add receiving domains later.

## Compatibility invariants

- Use the official `resend` client in tests. The supported baseline is pinned in `package.json`; legacy compatibility uses the aliased older package.
- Keep Resend field names, list envelopes, status codes, error objects, IDs, webhook payloads, and Svix-compatible headers exact within the documented surface.
- Transactional mail must not require audience contacts, segments, or campaign sender records and must not receive campaign footers.
- Incoming mail must preserve raw MIME, text/HTML, headers, threading fields, authentication results, attachment metadata, and exact decoded attachment bytes.
- Authentication is fail-closed unless `inboundAuthResultsVerified=true`. Trust only the authoritative first Cloudflare `Authentication-Results` boundary; never accept a sender-injected passing result.
- Webhook delivery is at least once. Preserve event payloads and IDs across retries/replay, sign the exact body, and expect consumers to deduplicate `svix-id`.
- R2 download URLs are signed, short-lived, and private. Do not expose bucket objects directly or log signed URLs.
- Callback endpoints and URL attachments must remain public HTTPS destinations without redirects or private/reserved network resolution.

## Development and verification

Use Node.js 22+ and the pinned dependencies.

```bash
npm install
npm run check
npm test
```

Run `npm run test:stress` for audience/fan-out changes. Run `npm run deploy:dry` only from a checkout with the correct `.deployment.json` and Access state; it renders account-specific configuration but does not deploy. A missing state/output failure in another worktree is a safety signal, not a reason to fabricate outputs.

For code changes:

- Add contract coverage for every changed Resend-facing behavior and focused unit coverage for MIME, authentication, DNS, or queue edge cases.
- Do not add test-only branches, environment flags, endpoints, or production exports.
- Keep queue work bounded and idempotent; D1 and Queue delivery are at least once.
- Use `ctx.waitUntil` for post-response work and await all other I/O. Do not place mutable request state in module globals.
- Apply formatting/build output only through the existing npm scripts. Do not commit generated `dist-assets`, Worker types, deployment config, local state, backups, or credentials.

## Deployment handoff

When a deployment is explicitly requested, report the target account, Worker, admin/API hostnames, D1 database, Queues, R2 bucket, migrations, secret names (never values), resulting version ID, and endpoint verification. Clearly distinguish local code changes, a committed/pushed revision, and a deployed revision; none implies the others.
