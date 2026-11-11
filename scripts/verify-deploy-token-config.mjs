import {
  apiTokenTemplateUrl,
  deploymentTokenPermissions,
  emailDiscoveryTokenPermissions,
  emailRoutingTokenPermissions,
  imagesTokenPermissions,
} from "./cloudflare-token-config.mjs";

const accountId = "00000000000000000000000000000001";

verify("deployment", deploymentTokenPermissions, [
  ["access", "edit"],
  ["access_acct", "read"],
]);
verify("Email Sending discovery", emailDiscoveryTokenPermissions, [
  ["email_sending", "edit"],
  ["zone", "read"],
]);
verify("Email Routing", emailRoutingTokenPermissions, [
  ["zone", "read"],
  ["dns", "edit"],
  ["zone_settings", "edit"],
  ["email_routing_rule", "edit"],
]);
verify("Images", imagesTokenPermissions, [["images", "edit"]]);

console.log("Cloudflare token templates verified.");

function verify(name, permissions, expectedPairs) {
  const url = new URL(apiTokenTemplateUrl(accountId, permissions, `Open Resend ${name}`));
  assert(url.origin === "https://dash.cloudflare.com", `${name} token must use the Cloudflare dashboard`);
  assert(url.pathname === "/profile/api-tokens", `${name} token must use the user-token form`);
  assert(url.searchParams.get("accountId") === accountId, `${name} token must be restricted to the selected account`);
  assert(url.searchParams.get("zoneId") === "all", `${name} token must cover zones in the selected account`);
  const actualPairs = JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "[]")
    .map(({ key, type }) => [key, type]);
  assert(JSON.stringify(actualPairs) === JSON.stringify(expectedPairs), `${name} token permissions changed unexpectedly`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
