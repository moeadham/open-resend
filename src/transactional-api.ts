import { jsonObject } from "./email-security";
import { Hono } from "hono";
import { AppError, nowIso } from "./lib";
import { createOutgoingEmail } from "./outgoing-email";
import {
  downloadInfo,
  emailResponse,
  mailRow,
  storedMail,
  type MailRow,
} from "./transactional-storage";

export async function listEmails(
  env: Env,
  direction: "sending" | "receiving",
  query: Record<string, string>,
) {
  const limit = Number(query.limit ?? 20);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (query.after && query.before)
  )
    throw new AppError(
      422,
      "validation_error",
      "Invalid pagination parameters.",
    );
  const cursor = query.after ?? query.before;
  let filter = "";
  const bindings: (string | number)[] = [direction, nowIso()];
  if (cursor) {
    const row = await mailRow(env, cursor, direction);
    const op = query.before ? ">" : "<";
    filter = ` AND (created_at ${op} ? OR (created_at=? AND id ${op} ?))`;
    bindings.push(row.created_at, row.created_at, row.id);
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM transactional_emails WHERE direction=? AND expires_at>? ${filter} ORDER BY created_at ${query.before ? "ASC" : "DESC"},id ${query.before ? "ASC" : "DESC"} LIMIT ?`,
  )
    .bind(...bindings, limit + 1)
    .all<MailRow>();
  const data = rows.results.slice(0, limit);
  if (query.before) data.reverse();
  return {
    object: "list",
    has_more: rows.results.length > limit,
    data: await Promise.all(
      data.map(async (row) => {
        const mail = await storedMail(env, row.id);
        return {
          id: row.id,
          to: mail.to,
          from: mail.from,
          created_at: row.created_at,
          subject: mail.subject,
          bcc: mail.bcc,
          cc: mail.cc,
          reply_to: mail.reply_to,
          ...(direction === "sending"
            ? {
                last_event: row.status,
                scheduled_at: null,
                tags: mail.tags ?? [],
              }
            : { message_id: mail.message_id, attachments: mail.attachments }),
        };
      }),
    ),
  };
}
export const transactionalApi = new Hono<{ Bindings: Env }>();
transactionalApi.post("/", async (c) =>
  c.json({
    id: await createOutgoingEmail(
      c.env,
      await jsonObject(await c.req.text()),
      c.get("apiKeyId"),
    ),
  }),
);
transactionalApi.get("/", async (c) =>
  c.json(await listEmails(c.env, "sending", c.req.query())),
);
transactionalApi.get("/receiving", async (c) =>
  c.json(await listEmails(c.env, "receiving", c.req.query())),
);
transactionalApi.get("/receiving/:id/attachments/:attachmentId", async (c) => {
  const row = await mailRow(c.env, c.req.param("id"), "receiving");
  const mail = await storedMail(c.env, row.id);
  const attachment = mail.attachments.find(
    (a) => a.id === c.req.param("attachmentId"),
  );
  if (!attachment)
    throw new AppError(404, "not_found", "Attachment not found.");
  return c.json({
    object: "attachment",
    ...attachment,
    ...(await downloadInfo(c.env, row, `attachment-${attachment.id}`)),
  });
});
transactionalApi.get("/receiving/:id/attachments", async (c) => {
  const row = await mailRow(c.env, c.req.param("id"), "receiving");
  const mail = await storedMail(c.env, row.id);
  const query = c.req.query();
  if (query.before && query.after)
    throw new AppError(
      422,
      "validation_error",
      "before and after cannot be combined.",
    );
  const limit =
    query.limit === undefined ? mail.attachments.length : Number(query.limit);
  if (
    query.limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > 100)
  )
    throw new AppError(422, "validation_error", "Invalid limit.");
  let items = mail.attachments;
  const cursor = query.after ?? query.before;
  if (cursor) {
    const index = items.findIndex((a) => a.id === cursor);
    if (index < 0)
      throw new AppError(404, "not_found", "Attachment cursor not found.");
    items = query.after ? items.slice(index + 1) : items.slice(0, index);
  }
  const selected = query.before ? items.slice(-limit) : items.slice(0, limit);
  return c.json({
    object: "list",
    has_more: items.length > limit,
    data: await Promise.all(
      selected.map(async (a) => ({
        ...a,
        ...(await downloadInfo(c.env, row, `attachment-${a.id}`)),
      })),
    ),
  });
});
transactionalApi.get("/receiving/:id", async (c) =>
  c.json(
    await emailResponse(
      c.env,
      await mailRow(c.env, c.req.param("id"), "receiving"),
      c.req.query("html_format"),
    ),
  ),
);
transactionalApi.get("/:id", async (c) =>
  c.json(
    await emailResponse(
      c.env,
      await mailRow(c.env, c.req.param("id"), "sending"),
    ),
  ),
);
