import { timingSafeEqual } from "node:crypto";
import { AppError, nowIso } from "./lib";
import { hmac } from "./email-security";

export type MailRow = {
  id: string;
  direction: "sending" | "receiving";
  from_value: string;
  to_json: string;
  subject: string;
  api_key_id: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  download_secret: string;
};
export type Attachment = {
  id: string;
  filename: string | null;
  size: number;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
};
export type StoredMail = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  message_id: string | null;
  attachments: Attachment[];
  tags?: { name: string; value: string }[];
  received_for?: string[];
  authentication?: { spf: string; dkim: string; dmarc: string } | null;
};
export const objectKey = (id: string, part: string) => `emails/${id}/${part}`;
export async function mailRow(
  env: Env,
  id: string,
  direction?: string,
): Promise<MailRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM transactional_emails WHERE id=? AND expires_at>?",
  )
    .bind(id, nowIso())
    .first<MailRow>();
  if (!row || (direction && row.direction !== direction))
    throw new AppError(404, "not_found", "Email not found.");
  return row;
}
export async function storedMail(env: Env, id: string): Promise<StoredMail> {
  const object = await env.EMAIL_STORAGE.get(objectKey(id, "content.json"));
  if (!object) throw new AppError(404, "not_found", "Email content not found.");
  return object.json<StoredMail>();
}
export async function downloadInfo(env: Env, row: MailRow, part: string) {
  const expires = Math.min(Date.now() + 3600_000, Date.parse(row.expires_at));
  const signature = await hmac(
    row.download_secret,
    `${row.id}\n${part}\n${expires}`,
  );
  const url = new URL(
    `https://${env.API_HOSTNAME}/email-content/${row.id}/${part}`,
  );
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature);
  return {
    download_url: url.href,
    expires_at: new Date(expires).toISOString(),
  };
}
export async function downloadEmailContent(
  request: Request,
  env: Env,
  id: string,
  part: string,
): Promise<Response> {
  const row = await mailRow(env, id);
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  if (
    !Number.isSafeInteger(expires) ||
    expires <= Date.now() ||
    expires > Date.now() + 3600_000 ||
    expires > Date.parse(row.expires_at)
  )
    throw new AppError(
      403,
      "restricted_api_key",
      "Download link expired or invalid.",
    );
  const expected = await hmac(
    row.download_secret,
    `${id}\n${part}\n${expires}`,
  );
  const a = new TextEncoder().encode(signature),
    b = new TextEncoder().encode(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new AppError(
      403,
      "restricted_api_key",
      "Invalid download signature.",
    );
  if (part !== "raw.eml" && !/^attachment-[0-9a-f-]{36}$/.test(part))
    throw new AppError(404, "not_found", "Content not found.");
  const object = await env.EMAIL_STORAGE.get(objectKey(id, part));
  if (!object) throw new AppError(404, "not_found", "Content not found.");
  const headers = new Headers({
    "Content-Type":
      object.httpMetadata?.contentType ?? "application/octet-stream",
    "Content-Disposition":
      object.httpMetadata?.contentDisposition ?? "attachment",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  return new Response(object.body, { headers });
}
export async function emailResponse(
  env: Env,
  row: MailRow,
  htmlFormat = "data_uri",
) {
  const mail = await storedMail(env, row.id);
  const { attachments, headers, authentication, received_for, ...base } = mail;
  if (row.direction === "sending")
    return {
      object: "email",
      id: row.id,
      ...base,
      created_at: row.created_at,
      last_event: row.status,
      scheduled_at: null,
    };
  if (!["cid", "data_uri"].includes(htmlFormat))
    throw new AppError(
      422,
      "validation_error",
      "html_format must be cid or data_uri.",
    );
  let html = mail.html;
  let actualFormat = htmlFormat;
  if (html && htmlFormat === "data_uri") {
    let total = html.length;
    for (const attachment of attachments.filter((a) => a.content_id)) {
      const cid = `cid:${attachment.content_id}`;
      const matches = html.split(cid).length - 1;
      total += matches * Math.ceil(attachment.size / 3) * 4;
    }
    // Reserve room for JSON serialization below the Worker's 128 MiB memory limit.
    if (total > 16_000_000) actualFormat = "cid";
    else
      for (const attachment of attachments.filter((a) => a.content_id)) {
        const object = await env.EMAIL_STORAGE.get(
          objectKey(row.id, `attachment-${attachment.id}`),
        );
        if (object) {
          const { Buffer } = await import("node:buffer");
          html = html
            .split(`cid:${attachment.content_id}`)
            .join(
              `data:${attachment.content_type};base64,${Buffer.from(await object.arrayBuffer()).toString("base64")}`,
            );
        }
      }
  }
  return {
    object: "email",
    id: row.id,
    ...base,
    html,
    html_format: actualFormat,
    headers,
    authentication: authentication ?? null,
    received_for: received_for ?? [],
    created_at: row.created_at,
    attachments,
    raw: await downloadInfo(env, row, "raw.eml"),
  };
}
