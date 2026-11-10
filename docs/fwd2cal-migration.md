# fwd2cal migration to Open Resend

## Current status

Prepared on 2026-11-02 in Cloudflare account
`8482edf397d8429a1d65532f6e1e6ed7`, using the existing `cloudflare-resend`
installation. Production MX is still Resend; the migration is not complete.

- Admin: https://cloudflare-mail.moeadham.com (existing Access protection).
- API: https://cloudflare-mail-api.moeadham.com.
- Additional API hostname for test-domain integration: https://resend-api.fwd2cal.com.
  Deployed and verified on 2026-11-10: valid API keys succeed; missing and
  invalid keys are rejected. The existing API hostname remains available.
- D1: existing `cloudflare-resend`, backed up before applying migrations.
- Private R2: `cloudflare-resend-email`.
- New webhook queue: `cloudflare-resend-webhooks`.
- Existing delivery/event/dead-letter queues retained.
- Dedicated test address: `open-resend-check@ninety.live`.
- Production callback enabled after live verification at
  `https://app.fwd2cal.com/v2/resendInboundCallback`.
- `INBOUND_AUTH_RESULTS_VERIFIED=false` until remaining live checks complete.

The existing installation's earlier migrations stopped at 0003. Additive
migrations through 0008 were applied after a database backup. Existing contacts,
broadcasts, keys, custom domains, and Access configuration were preserved.

The actual fwd2cal client and calendar attachment handler fetched a received
email from the upgraded API and downloaded the original ICS bytes correctly.
The outgoing provider event marked the test email delivered. A further message
sent through fwd2cal's actual `sendEmail(..., "calendar")` helper traversed Open
Resend, Email Routing, the webhook queue, and the production Firebase callback.
The callback returned HTTP 200 in one attempt and intentionally skipped task
dispatch for the non-calendar test recipient.

## fwd2cal code changes

Changes are in `/Users/m/workspace/fwd2cal`, based on `98cfc30`:

- Resend SDK pinned to 6.32.0 for per-instance `baseUrl` support.
- `CALENDAR_MAIL_API_URL`, `CALENDAR_MAIL_API_KEY`, and
  `CALENDAR_MAIL_SIGNING_SECRET` configure calendar-only Open Resend use.
- Calendar sends opt into that client; fwd2drive retains its existing provider.
- The callback verifies exact raw request bytes against either signing secret.
- Internal `mailProvider` is assigned after verification, overwriting any value
  from request JSON. The dispatch handler selects the corresponding receiving
  API. Old queued tasks without the field continue to use Resend.
- Existing Resend credentials remain for mail arriving during DNS propagation
  and for existing contact synchronization. They are not removed during cutover.

The production callback and dispatch functions are deployed and ACTIVE with
the expected calendar-only settings. Live callback requests signed with either
provider secret passed; an invalid signature returned HTTP 401. Controlled
requests used a non-calendar recipient, so no calendar task was created.

Build, lint, and two migration contract tests pass. The tests cover independent
API URLs/keys, old and new webhook signatures, byte-sensitive payloads, and
rejection of a third, untrusted signing secret.

## Remaining cutover steps

1. Completed: deploy and verify both functions and both signing secrets.
2. Completed: both user-forwarded messages passed SPF, DKIM, and DMARC in
   Cloudflare's authoritative header. All three MIME attachments matched
   independently decoded original bytes. The real fwd2cal attachment handler
   processed the named ICS file and parsed one event. The other calendar part
   was an unnamed inline alternative, retained in the receiving API. No event
   was added to a calendar.
3. Complete a controlled failing-authentication test. Direct SMTP from this
   workstation is blocked; use an isolated sender domain and explicit DNS
   controls, or an authorized external SMTP source. Never weaken authentication
   on the production sending domain.
4. Enable authentication reporting only after those checks pass.
5. The next DNS target is the test subdomain `r.fwd2cal.com`, as clarified
   with the user. Configure its receiving rules and matching test callback,
   recording rule IDs for rollback. Verify that subdomain activation does not
   alter apex routing or DNS.
6. Change only the test subdomain MX to Cloudflare and retain the legacy
   callback during propagation. Production `fwd2cal.com` MX and its SPF record
   remain unchanged. A later production cutover requires a successful test
   round trip and a concrete production migration review.
7. Verify public DNS, a signed callback to Firebase, successful dispatch/fetch,
   ICS processing, and an outgoing reply before reporting migration complete.

A zone-scoped routing token is installed and saved in the ignored local secrets
file. Cloudflare MX/SPF records have been added to `r.fwd2cal.com`, but the old
Amazon/Resend MX remains. Apex `fwd2cal.com` MX records are unchanged. Before
retrying **Migrate now**, grant the routing token **Zone Settings Edit** so the
new API activation step can succeed. The updated flow removes only the selected
domain's old MX records and attempts to restore them if activation fails.

## Local operational state

Ignored `.deployment.json` identifies the correct account and installation.
`.wrangler/migration/wrangler.json` is the exact deployment configuration used
for this upgrade. Existing Access settings were read from the deployed Worker;
Terraform ownership was not changed.

Backups and credentials are in the ignored `.wrangler/migration/` directory with
private file permissions. Do not commit those files or print their contents.
The directory includes the database export, original Firebase environment,
new API key and webhook credentials, deployment logs, and test records.

## Rollback

Before MX change, legacy incoming mail remains unaffected. Disable the new
webhook and clear the three calendar-only mail settings to return outgoing mail
to its previous provider. Retain the new adapter code during transition so
already queued Open Resend IDs can still be fetched.

After MX change, restore the saved Resend MX record and previous SPF record,
allow propagation to finish, and keep both callbacks and API credentials valid
until all in-flight messages have been handled. Remove only the literal routing
rules created for this migration. Never remove the existing admin rule.
