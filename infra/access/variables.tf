variable "account_id" {
  description = "Cloudflare account that owns the Zero Trust organization and Access application."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32-character Cloudflare account ID."
  }
}

variable "admin_hostname" {
  description = "Complete public hostname of the admin site, without a scheme or path."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$", var.admin_hostname))
    error_message = "admin_hostname must be a hostname such as mail-admin.example.com, without a scheme or path."
  }
}

variable "allowed_account_id" {
  description = "Cloudflare account whose members may use the admin site. Defaults to account_id."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.allowed_account_id == null || can(regex("^[0-9a-f]{32}$", var.allowed_account_id))
    error_message = "allowed_account_id must be null or a 32-character Cloudflare account ID."
  }
}

variable "application_name" {
  description = "Name shown for the Access application."
  type        = string
  default     = "Open Re-send Admin"
}

variable "session_duration" {
  description = "How long an authenticated Access application session remains valid."
  type        = string
  default     = "24h"

  validation {
    condition     = can(regex("^[0-9]+(?:ns|us|µs|ms|s|m|h)(?:[0-9]+(?:ns|us|µs|ms|s|m|h))*$", var.session_duration))
    error_message = "session_duration must use Cloudflare's duration format, for example 24h or 2h45m."
  }
}
