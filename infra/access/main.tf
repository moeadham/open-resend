data "cloudflare_zero_trust_organization" "current" {
  account_id = var.account_id
}

data "cloudflare_zero_trust_access_identity_providers" "current" {
  account_id = var.account_id
}

locals {
  cloudflare_identity_provider_ids = [
    for provider in data.cloudflare_zero_trust_access_identity_providers.current.result : provider.id
    if provider.type == "cloudflare"
  ]
}

resource "cloudflare_zero_trust_access_policy" "account_members" {
  account_id = var.account_id
  name       = "Allow Cloudflare account members"
  decision   = "allow"

  include = [{
    cloudflare_account_member = {
      account_id = coalesce(var.allowed_account_id, var.account_id)
    }
  }]
}

resource "cloudflare_zero_trust_access_application" "admin" {
  account_id                = var.account_id
  name                      = var.application_name
  domain                    = lower(var.admin_hostname)
  type                      = "self_hosted"
  session_duration          = var.session_duration
  app_launcher_visible      = false
  allowed_idps              = local.cloudflare_identity_provider_ids
  auto_redirect_to_identity = true

  destinations = [{
    type = "public"
    uri  = lower(var.admin_hostname)
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.account_members.id
    precedence = 1
  }]

  lifecycle {
    precondition {
      condition     = length(local.cloudflare_identity_provider_ids) == 1
      error_message = "Exactly one Cloudflare identity provider must exist. Activate Zero Trust and configure Cloudflare as the account-member identity provider before applying."
    }
  }
}
