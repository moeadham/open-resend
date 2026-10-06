# Access infrastructure

This directory manages the Cloudflare Zero Trust boundary around the complete admin hostname. It deliberately does not manage the Worker, DNS custom domains, D1, Queues, or Email Service; Wrangler remains the owner of those resources.

## Prerequisites

- Terraform 1.10 or newer
- An activated Cloudflare Zero Trust organization
- Exactly one Cloudflare account-member identity provider (created automatically for new Zero Trust organizations)
- `CLOUDFLARE_API_TOKEN` with Access application/policy write permission and Zero Trust organization read permission

## Apply

```bash
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

The Allow policy uses Cloudflare's account-member selector. `allowed_account_id = null` means members of `account_id`; set a different account ID only for intentional cross-account access. All other identities are denied by the Access application's default-deny behavior.

The application audience, team domain, and admin hostname are Terraform outputs. The repository's `npm run config:deploy` command reads those values and writes the ignored root-level `wrangler.deploy.jsonc` file.

Remove any dashboard-managed Access application for the same hostname before applying. This project intentionally has one clean, Terraform-owned installation path and does not include migration compatibility for manually managed applications.

Never commit `terraform.tfvars`, Terraform state, or Cloudflare API tokens. Use a remote state backend with locking when more than one person manages a deployment.
