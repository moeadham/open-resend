import { AppError, nowIso } from "./lib";

type CloudflareDiscoveryEnv = Env & {
  CLOUDFLARE_EMAIL_DISCOVERY_TOKEN?: string;
};

type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ message?: string }>;
  result_info?: { page?: number; total_pages?: number };
};

type SendingZone = { id: string; name: string };
type SendingSubdomain = { enabled: boolean; name: string };

export type DomainSyncResult = {
  enabled: string[];
  disabled: number;
  skippedWildcards: number;
};

export async function listEnabledSendingDomains(
  accountId: string,
  token: string,
  request: typeof fetch = fetch,
): Promise<{ domains: string[]; skippedWildcards: number }> {
  const zones = await fetchCloudflarePages<SendingZone>(
    `/accounts/${accountId}/email/sending/zones`,
    token,
    request,
  );
  const subdomains = (await Promise.all(zones.map((zone) =>
    fetchCloudflarePages<SendingSubdomain>(`/zones/${zone.id}/email/sending/subdomains`, token, request)
  ))).flat();
  const skippedWildcards = subdomains.filter((domain) => domain.enabled && domain.name.startsWith("*.")).length;
  const domains = [...new Set(subdomains
    .filter((domain) => domain.enabled && !domain.name.startsWith("*."))
    .map((domain) => domain.name.toLowerCase()))].sort();
  return { domains, skippedWildcards };
}

export async function syncSendingDomains(env: CloudflareDiscoveryEnv): Promise<DomainSyncResult> {
  const token = env.CLOUDFLARE_EMAIL_DISCOVERY_TOKEN;
  if (!token) throw new AppError(503, "application_error", "Sending-domain sync is not configured. Redeploy Open Resend to install its Cloudflare discovery token.");
  const { domains, skippedWildcards } = await listEnabledSendingDomains(env.CLOUDFLARE_ACCOUNT_ID, token);
  const syncedAt = nowIso();
  const statements = [
    env.DB.prepare("UPDATE domains SET cloudflare_enabled=0,last_synced_at=?").bind(syncedAt),
    ...domains.map((domain) => env.DB.prepare(`INSERT INTO domains (id,name,created_at,cloudflare_enabled,last_synced_at)
      VALUES (?,?,?,1,?) ON CONFLICT(name) DO UPDATE SET cloudflare_enabled=1,last_synced_at=excluded.last_synced_at`)
      .bind(crypto.randomUUID(), domain, syncedAt, syncedAt)),
    env.DB.prepare(`DELETE FROM domains WHERE cloudflare_enabled=0
      AND NOT EXISTS (SELECT 1 FROM senders WHERE senders.domain_id=domains.id)`),
  ];
  await env.DB.batch(statements);
  const disabled = await env.DB.prepare("SELECT COUNT(*) AS count FROM domains WHERE cloudflare_enabled=0")
    .first<{ count: number }>();
  return { enabled: domains, disabled: Number(disabled?.count ?? 0), skippedWildcards };
}

async function fetchCloudflarePages<T>(path: string, token: string, request: typeof fetch): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const url = new URL(`https://api.cloudflare.com/client/v4${path}`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    const response = await request(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => null) as CloudflareEnvelope<T[]> | null;
    if (!response.ok || !body?.success || !Array.isArray(body.result)) {
      const detail = body?.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new AppError(502, "application_error", `Cloudflare Email Sending could not be read${detail ? `: ${detail}` : "."}`);
    }
    results.push(...body.result);
    const totalPages = Number(body.result_info?.total_pages ?? 1);
    if (page >= totalPages) return results;
  }
  throw new AppError(502, "application_error", "Cloudflare Email Sending returned too many pages.");
}
