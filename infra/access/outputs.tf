output "access_application_id" {
  description = "ID of the admin Access application."
  value       = cloudflare_zero_trust_access_application.admin.id
}

output "access_policy_id" {
  description = "ID of the account-member Access policy."
  value       = cloudflare_zero_trust_access_policy.account_members.id
}

output "access_aud" {
  description = "Audience used by the Worker to validate Cf-Access-Jwt-Assertion."
  value       = cloudflare_zero_trust_access_application.admin.aud
}

output "access_team_domain" {
  description = "Zero Trust team domain used as the JWT issuer and JWKS host."
  value       = trimsuffix(trimprefix(data.cloudflare_zero_trust_organization.current.auth_domain, "https://"), "/")
}

output "admin_hostname" {
  description = "Hostname protected by the Access application."
  value       = lower(var.admin_hostname)
}
