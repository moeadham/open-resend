import PostalMime from "postal-mime";
import { Buffer } from "node:buffer";

/** postal-mime normalizes calendar attachments to LF/UTF-8. Alias their MIME
 * types only in header blocks to obtain the original decoded attachment bytes.
 * The original raw message is kept unchanged in R2.
 */
export async function parseEmail(raw: Uint8Array) {
  const source = Buffer.from(raw).toString("latin1");
  const suffix = crypto.randomUUID();
  const calendarType = `application/x-open-resend-calendar-${suffix}`;
  const icsType = `application/x-open-resend-ics-${suffix}`;
  const boundaries = new Set<string>();
  const edits: { start: number; end: number; value: string }[] = [];
  let inHeaders = true,
    headerStart = 0,
    position = 0;
  const headerBlock = (end: number) => {
    const block = source.slice(headerStart, end);
    const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
    const contentType = unfolded.match(/^content-type:([^\r\n]+)/im)?.[1] ?? "";
    const boundary = contentType.match(
      /\bboundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i,
    );
    if (boundary) boundaries.add(boundary[1] ?? boundary[2]!);
    const value = block.replace(
      /(^|\n)(content-type:[ \t]*(?:\r?\n[ \t]+)?)(text\/calendar|application\/ics)(?=[;\s]|$)/gi,
      (_match, start: string, key: string, type: string) =>
        `${start}${key}${type.toLowerCase() === "text/calendar" ? calendarType : icsType}`,
    );
    if (value !== block) edits.push({ start: headerStart, end, value });
  };
  while (position < source.length) {
    const newline = source.indexOf("\n", position);
    const end = newline < 0 ? source.length : newline + 1;
    const line = source.slice(position, end).replace(/\r?\n$/, "");
    if (inHeaders) {
      if (!line) {
        headerBlock(position);
        inHeaders = false;
      }
    } else if (line.startsWith("--") && boundaries.has(line.slice(2))) {
      inHeaders = true;
      headerStart = end;
    }
    position = end;
  }
  if (inHeaders) headerBlock(source.length);
  let input = raw;
  if (edits.length) {
    let previous = 0;
    const chunks: string[] = [];
    for (const edit of edits) {
      chunks.push(source.slice(previous, edit.start), edit.value);
      previous = edit.end;
    }
    chunks.push(source.slice(previous));
    input = Buffer.from(chunks.join(""), "latin1");
  }
  const parsed = await PostalMime.parse(input, {
    attachmentEncoding: "arraybuffer",
    maxPartCount: 512,
    maxNestingDepth: 50,
    maxHeadersSize: 1024 * 1024,
  });
  for (const attachment of parsed.attachments) {
    if (attachment.mimeType === calendarType)
      attachment.mimeType = "text/calendar";
    if (attachment.mimeType === icsType)
      attachment.mimeType = "application/ics";
  }
  return parsed;
}
