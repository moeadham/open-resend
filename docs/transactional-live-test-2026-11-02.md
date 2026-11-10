# Transactional email validation — 2026-11-02

Tested in an isolated staging deployment in the Cloudflare account selected by
the user. A literal route for `open-resend-test-20261102@ninety.live` delivered to
that deployment. Existing DNS and catch-all forwarding were unchanged. Test
messages were sent from the account's enabled `fwd2cal.com` sending domain.

## Results

- All 68 automated tests across eight files pass. Asset build, generated types,
  TypeScript, deployment config validation, dry run, and live deployment pass.
- The actual Resend SDK created a webhook and sent an email. Retrying the same
  idempotency key returned the same ID and did not send another copy.
- The real Cloudflare sending queue delivered the message to Email Routing.
  Its provider event advanced the outgoing email to `delivered`.
- The receiving SDK retrieved Unicode text/HTML, threading headers, attachments,
  raw MIME, and inline image data URIs.
- Calendar attachment (228 bytes, CRLF and Japanese text), binary attachment
  (10 bytes, including NUL and high bytes), and inline PNG (67 bytes) downloaded
  from private R2 through signed URLs with exact original bytes.
- Missing API credentials and modified download signatures were rejected.
- A live raw MIME probe supplied two forged Authentication-Results headers,
  including `mx.cloudflare.net`. Both remained in raw MIME, below Cloudflare's
  authoritative, prepended result. The adapter ignored them. With verification
  explicitly enabled in staging, SPF, DKIM, and DMARC were all `pass`.
- A separate callback Worker independently verified Svix-compatible signatures.
  Invalid signatures were rejected. An intentional HTTP 503 was retried and
  succeeded with HTTP 200. Replay invoked the real replay handler, retained
  the event ID and exact payload, and used a fresh signed timestamp.

## Problems found and fixed

1. Real Cloudflare headers contain separate HELO and MAIL FROM SPF results.
   The initial parser selected HELO's `none`, hiding the envelope sender's
   `pass`. It now prefers `smtp.mailfrom`. Parsing also removes comments and
   quoted values before interpreting method results. Regression cases fail
   with the old SPF selection and pass with the fix.
2. Callback fetches to Workers on the same account returned Cloudflare 1042.
   Added `global_fetch_strictly_public` so callbacks and attachment URL fetches
   use public routing. Verified successful Worker-to-Worker delivery afterward.

## Remaining scope

This run did not test the deployed fwd2cal application itself. The later migration preparation found that checkout `98cfc30` already
contains the attachment fix and verified its actual fetch/transform and calendar
attachment handler against the upgraded deployment. See [migration status](fwd2cal-migration.md).

The failed-authentication and forwarded-mail cases in the production release
gate remain unverified live. Direct SMTP from this machine timed out. Automated
cases cover failed, missing, and forged results, but do not establish how a
particular upstream forwarding provider handles them. The default
`inboundAuthResultsVerified=false` remains unchanged; staging alone enabled it
for this controlled run.

The temporary receiving rule, event subscription, Workers, queues, D1 database,
and R2 bucket were removed after validation. No production fwd2cal route was
changed. Local test scripts and raw evidence remain in the ignored
`.wrangler/live-test/` directory; credentials are excluded from this report.

## Platform references

- [Cloudflare authentication header boundary](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#authentication-results)
- [Cloudflare Worker-to-Worker fetch requirements](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
