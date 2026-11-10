import { Buffer } from "node:buffer";
import { Resolver } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { AppError } from "./lib";

export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
export const RETENTION_MS = 30 * 86400_000;

export function publicUrl(value: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new AppError(
      422,
      "validation_error",
      "A valid HTTPS URL is required.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  ) {
    throw new AppError(
      422,
      "validation_error",
      "A public HTTPS URL without credentials is required.",
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !host.includes(".") ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    ipaddr.isValid(host)
  ) {
    throw new AppError(
      422,
      "validation_error",
      "A public DNS hostname is required.",
    );
  }
  return url;
}

export async function publicFetch(
  value: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = publicUrl(value);
  const resolver = new Resolver({ timeout: 5000, tries: 1 });
  const answers = await Promise.allSettled([
    resolver.resolve4(url.hostname),
    resolver.resolve6(url.hostname),
  ]);
  const addresses = answers.flatMap((r) =>
    r.status === "fulfilled" ? r.value : [],
  );
  if (
    !addresses.length ||
    addresses.some((a) => ipaddr.process(a).range() !== "unicast")
  ) {
    throw new AppError(
      422,
      "validation_error",
      "The destination must resolve exclusively to public addresses.",
    );
  }
  // Cloudflare's fetch uses its own public resolver; never follow a redirect to a second origin.
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new AppError(
      422,
      "validation_error",
      "Redirects are not allowed for email destinations.",
    );
  }
  return response;
}

export async function boundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new AppError(
          413,
          "validation_error",
          "Email content exceeds the size limit.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function randomSecret(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  );
}
export async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
      ),
    ),
  );
}

export async function jsonObject(
  request: Request | string,
  maximum = 36 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  try {
    const text =
      typeof request === "string"
        ? request
        : new TextDecoder().decode(await boundedBytes(request.body, maximum));
    if (Buffer.byteLength(text) > maximum)
      throw new AppError(413, "validation_error", "Request body is too large.");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      400,
      "validation_error",
      "Request body must be a JSON object.",
    );
  }
}
