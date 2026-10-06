import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context, Next } from "hono";
import { AppError, nowIso, sha256 } from "./lib";

type AppContext = Context<{ Bindings: Env }>;

function hostname(request: Request): string {
  return new URL(request.url).hostname.toLowerCase();
}

export function isAdminRequest(request: Request, env: Env): boolean {
  const host = hostname(request);
  return host === env.ADMIN_HOSTNAME.toLowerCase() || (isLocalHost(host) && env.ENVIRONMENT !== "production");
}

export function isApiRequest(request: Request, env: Env): boolean {
  const host = hostname(request);
  return host === env.API_HOSTNAME.toLowerCase() || (isLocalHost(host) && env.ENVIRONMENT !== "production");
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export async function requireAccess(c: AppContext, next: Next): Promise<Response | void> {
  const host = hostname(c.req.raw);
  if (isLocalHost(host) && c.env.ENVIRONMENT !== "production" && String(c.env.ALLOW_LOCAL_ADMIN) === "true") {
    await next();
    return;
  }

  if (host !== c.env.ADMIN_HOSTNAME.toLowerCase()) {
    throw new AppError(403, "restricted_api_key", "Admin access is restricted to the configured hostname.");
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) throw new AppError(401, "invalid_api_key", "Cloudflare Access authentication is required.");

  const teamDomain = c.env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const issuer = `https://${teamDomain}`;
  try {
    const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: c.env.ACCESS_AUD });
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error("Access token has no valid expiration.");
    }
    c.set("accessIdentity", typeof payload.email === "string" ? payload.email : payload.sub ?? "unknown");
  } catch {
    throw new AppError(401, "invalid_api_key", "Invalid Cloudflare Access token.");
  }
  await next();
}

export async function requireSameOrigin(c: AppContext, next: Next): Promise<Response | void> {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    await next();
    return;
  }
  const origin = c.req.header("Origin");
  let originHost = "";
  try {
    originHost = origin ? new URL(origin).hostname.toLowerCase() : "";
  } catch {
    originHost = "";
  }
  if (originHost !== hostname(c.req.raw)) {
    throw new AppError(403, "restricted_api_key", "Cross-origin admin request rejected.");
  }
  await next();
}

export async function requireApiKey(c: AppContext, next: Next): Promise<Response | void> {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer re_")) {
    throw new AppError(401, "invalid_api_key", "Missing or invalid API key.");
  }
  const rawKey = authorization.slice("Bearer ".length);
  const keyHash = await sha256(rawKey);
  const key = await c.env.DB.prepare(
    "SELECT id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
  ).bind(keyHash).first<{ id: string }>();
  if (!key) throw new AppError(401, "invalid_api_key", "API key is invalid or revoked.");
  await c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(nowIso(), key.id).run();
  c.set("apiKeyId", key.id);
  await next();
}

declare module "hono" {
  interface ContextVariableMap {
    accessIdentity: string;
    apiKeyId: string;
  }
}
