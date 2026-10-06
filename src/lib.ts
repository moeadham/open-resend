import type { AppErrorName, BroadcastRow, ContactRow } from "./types";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public override readonly name: AppErrorName,
    message: string,
  ) {
    super(message);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

export function requiredString(value: unknown, field: string, max = 10_000): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(422, "missing_required_field", `Missing required field: ${field}.`);
  }
  if (value.length > max) {
    throw new AppError(422, "validation_error", `${field} is too long.`);
  }
  return value.trim();
}

export function optionalString(value: unknown, field: string, max = 100_000): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) {
    throw new AppError(422, "validation_error", `${field} must be a string of at most ${max} characters.`);
  }
  return value;
}

export function assertIsoFuture(value: string): string {
  const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  const time = Date.parse(value);
  if (!iso8601.test(value) || !Number.isFinite(time)) {
    throw new AppError(422, "invalid_parameter", "scheduled_at must be an ISO 8601 timestamp.");
  }
  if (time <= Date.now()) {
    throw new AppError(422, "invalid_parameter", "scheduled_at must be in the future.");
  }
  return new Date(time).toISOString();
}

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseUnsubscribeHostnames(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    const result: Record<string, string> = {};
    for (const [sendingDomain, hostname] of Object.entries(parsed)) {
      if (typeof hostname !== "string" || !isHostname(sendingDomain) || !isHostname(hostname)) throw new Error("invalid hostname");
      result[sendingDomain.toLowerCase()] = hostname.toLowerCase();
    }
    return result;
  } catch {
    throw new AppError(500, "application_error", "The unsubscribe hostname configuration is invalid.");
  }
}

export function parseSendingDomains(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((domain) => typeof domain !== "string" || !isHostname(domain))) throw new Error("invalid domains");
    return [...new Set(parsed.map((domain) => domain.toLowerCase()))].sort();
  } catch {
    throw new AppError(500, "application_error", "The Cloudflare Email Sending domain configuration is invalid.");
  }
}

export function unsubscribeBaseUrl(value: string, sendingDomain: string): string {
  const hostname = parseUnsubscribeHostnames(value)[sendingDomain.toLowerCase()];
  if (!hostname) {
    throw new AppError(422, "validation_error", `No unsubscribe hostname is configured for ${sendingDomain}.`);
  }
  return `https://${hostname}`;
}

function isHostname(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(value);
}

export function parseFrom(value: string): { email: string; name: string | null } {
  const match = value.match(/^\s*(?:([^<>]+?)\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (match) return { name: match[1]?.trim() || null, email: normalizeEmail(match[2] ?? "") };
  return { email: normalizeEmail(value), name: null };
}

export function contactResponse(row: ContactRow): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    unsubscribed: Boolean(row.unsubscribed),
    created_at: row.created_at,
  };
}

export function broadcastResponse(row: BroadcastRow): Record<string, unknown> {
  const status = row.status === "draft" ? "draft" : row.status === "sent" ? "sent" : "queued";
  return {
    object: "broadcast",
    id: row.id,
    name: row.name,
    segment_id: row.segment_id,
    topic_id: row.topic_id,
    audience_id: null,
    from: row.from_value,
    subject: row.subject,
    reply_to: row.reply_to_json ? JSON.parse(row.reply_to_json) : null,
    preview_text: row.preview_text,
    status,
    created_at: row.created_at,
    scheduled_at: row.scheduled_at,
    sent_at: row.sent_at,
    html: row.html,
    text: row.text,
  };
}

export function appErrorResponse(error: unknown): Response {
  const appError = error instanceof AppError
    ? error
    : new AppError(500, "application_error", "Internal server error.");
  return Response.json(
    { name: appError.name, message: appError.message, statusCode: appError.status },
    { status: appError.status },
  );
}

export function logError(message: string, error: unknown, data: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    level: "error",
    message,
    error: error instanceof Error ? error.message : String(error),
    timestamp: nowIso(),
    ...data,
  }));
}

export function safeJsonObject(value: unknown): Record<string, string | number | boolean | null> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(422, "validation_error", "properties must be an object.");
  }
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
      throw new AppError(422, "validation_error", `Invalid property value for ${key}.`);
    }
    output[key] = item as string | number | boolean | null;
  }
  return output;
}
