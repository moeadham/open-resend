export const deploymentTokenPermissions = [
  { key: "access", type: "edit" },
  { key: "access_acct", type: "read" },
];

export const emailDiscoveryTokenPermissions = [
  // Cloudflare registers email_sending:read but does not currently grant it.
  // Email Sending Edit is therefore required for the read-only discovery API.
  { key: "email_sending", type: "edit" },
  { key: "zone", type: "read" },
];

export const emailRoutingTokenPermissions = [
  { key: "zone", type: "read" },
  // Edit includes the reads used by the setup preview and the writes used by
  // Migrate now. Keep these zone-scoped and restricted to the selected account.
  { key: "dns", type: "edit" },
  { key: "zone_settings", type: "edit" },
  // Cloudflare's dashboard short key is singular even though the permission is
  // displayed as "Email Routing Rules".
  { key: "email_routing_rule", type: "edit" },
];

export const imagesTokenPermissions = [{ key: "images", type: "edit" }];

export function apiTokenTemplateUrl(accountId, permissions, name) {
  const url = new URL("https://dash.cloudflare.com/profile/api-tokens");
  url.searchParams.set("permissionGroupKeys", JSON.stringify(permissions));
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("zoneId", "all");
  url.searchParams.set("name", name);
  return url.toString();
}
