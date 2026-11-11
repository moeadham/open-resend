# Access infrastructure

This directory manages only the Cloudflare Zero Trust boundary around the complete Open Resend admin hostname. It deliberately does not manage the Worker, custom domains, DNS, D1, R2, Queues, Email Sending, or Email Routing. The root guided deploy uses Wrangler for application resources and invokes this Terraform module for Access.

## Prerequisites

- OpenTofu or Terraform 1.10 or newer
- An activated Cloudflare Zero Trust organization
- Exactly one Cloudflare account-member identity provider (created automatically for new Zero Trust organizations)
- `CLOUDFLARE_API_TOKEN`, restricted to the target account, with exactly:
  - **Access: Apps and Policies → Edit**
  - **Access: Organizations, Identity Providers, and Groups → Read**

This is the deployment token saved as `cloudflareApiTokens[accountId]` by the root `npm run deploy` flow. It is not the runtime Email Sending, Email Routing, or Images token.

## Apply

```bash
cp terraform.tfvars.example terraform.tfvars
tofu init
tofu plan
tofu apply
```

Use `terraform` instead of `tofu` if that is the installed compatible runner. Commands are run from this directory; from the repository root use `tofu -chdir=infra/access ...`.

The Allow policy uses Cloudflare's account-member selector. `allowed_account_id = null` means members of `account_id`; set a different account ID only for intentional cross-account access. All other identities are denied by the Access application's default-deny behavior.

The application audience, team domain, and admin hostname are Terraform outputs. The repository's `npm run config:deploy` command reads those values from this directory's state and writes the ignored root-level `wrangler.deploy.jsonc`. In a worktree without the state, rendering fails by design; run from the checkout that owns the deployment state or configure a shared remote backend with locking.

Remove any dashboard-managed Access application for the same hostname before applying. This project intentionally has one clean, Terraform-owned installation path and does not include migration compatibility for manually managed applications.

Never commit `terraform.tfvars`, Terraform/OpenTofu state, or Cloudflare API tokens. Do not copy state between Cloudflare accounts. Use a remote state backend with locking when more than one person manages a deployment.

The normal path is `npm run deploy` from the repository root. Running this module directly changes remote Access resources as soon as `apply` is approved; always verify the account ID and admin hostname in `terraform.tfvars` and review the plan first.
