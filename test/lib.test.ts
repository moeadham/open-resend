import { describe, expect, it } from "vitest";
import { buildCampaignMime, buildTestMime } from "../src/delivery";
import { parseFrom, randomToken, stripHtml, unsubscribeBaseUrl } from "../src/lib";
import type { DeliveryDetail } from "../src/types";

describe("mail helpers", () => {
  it("parses friendly sender addresses", () => {
    expect(parseFrom("Example News <news@example.com>")).toEqual({ name: "Example News", email: "news@example.com" });
  });

  it("creates URL-safe random tokens", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives a readable text body", () => {
    expect(stripHtml("<h1>Hello</h1><p>Cloudflare &amp; friends</p>")).toBe("Hello Cloudflare & friends");
  });

  it("builds multipart campaign MIME with plain text first and unsubscribe headers", () => {
    const detail: DeliveryDetail = {
      id: "delivery-1",
      broadcast_id: "broadcast-1",
      topic_id: null,
      contact_id: "contact-1",
      recipient: "reader@example.net",
      status: "enqueued",
      attempts: 0,
      message_id: null,
      subject: "Product update",
      html: "<p>Hello from the campaign.</p>",
      text: "Hello from the campaign.",
      preview_text: "A short preview",
      reply_to_json: null,
      broadcast_status: "queued",
      segment_id: "segment-1",
      sender_email: "news@example.com",
      sender_name: "Jane Smith",
      sender_company_name: "Example Company",
      sender_reply_to: "replies@example.com",
      sender_domain: "example.com",
      postal_address: "1 Main Street\r\nTokyo",
      sender_domain_enabled: 1,
      sender_active: 1,
    };
    const url = "https://api.example.com/unsubscribe/token";
    const raw = buildCampaignMime(detail, url);

    expect(raw).toContain(`List-Unsubscribe: <${url}>`);
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(raw).toContain("Reply-To: <replies@example.com>");
    const parts = decodedParts(raw);
    const html = parts[1];
    expect(parts[0]).toContain("1 Main Street\r\nTokyo");
    expect(html).toContain('role="contentinfo"');
    const fromHeader = raw.split("\r\n").find((line) => line.startsWith("From:"));
    expect(fromHeader).toContain("<news@example.com>");
    expect(fromHeader).not.toContain("Example Company");
    expect(html).toContain("Example Company");
    expect(html).toContain("1 Main Street<br>Tokyo");
    expect(raw).not.toMatch(/\r(?!\n)/);
    expect(html).toContain("text-align:center");
    expect(html).toContain("text-underline-offset:2px");
    expect(html).not.toContain('<hr>');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("font-size:16px;line-height:1.6");
    expect(html).toContain("max-width:600px");
    expect(html).toContain(".email-image-row .email-image-cell");
    expect(html).toContain("max-width:520px");
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("text/html"));

    const unicode = "Hello — 日本語 📂 café\r\n" + "long line ".repeat(500);
    const encoded = buildCampaignMime({ ...detail, text: unicode, html: `<p>${unicode}</p>` }, url);
    expect(encoded).not.toMatch(/[^\x00-\x7f]/);
    expect(encoded).not.toMatch(/\r(?!\n)|(?<!\r)\n/);
    expect(decodedParts(encoded)[0]).toContain(unicode);
    expect(decodedParts(encoded)[1]).toContain(`<p>${unicode}</p>`);
    expect(decodedParts(encoded)[0]).toContain("—\r\nExample Company");

    const template = '<!doctype html><html><head><style>body{color:purple}</style></head><body style="background:pink"><p>Custom template</p></body></html>';
    const imported = decodedParts(buildCampaignMime({ ...detail, html: template }, url))[1]!;
    expect(imported.match(/<html>/g)).toHaveLength(1);
    expect(imported).toContain('body style="background:pink"');
    expect(imported).toContain('body{color:purple}');
    expect(imported.indexOf('role="contentinfo"')).toBeLessThan(imported.indexOf("</body>"));
  });

  it("encodes test emails with the same responsive presentation", () => {
    const env = { UNSUBSCRIBE_HOSTNAMES: JSON.stringify({ "example.com": "mail.example.com" }) };
    const raw = buildTestMime(env, {
      to: "reader@example.net", subject: "Unicode 📂", html: '<p>Hello 日本語 — café</p><p><img src="https://imagedelivery.net/account/image/public" alt="Product preview" width="272" style="width:272px;max-width:100%;height:auto"></p>',
      sender: { email: "news@example.com", name: "Jane", company_name: null, reply_to: null, postal_address: "1 Main Street\r\nTokyo", domain: "example.com" },
    });
    expect(raw).not.toMatch(/[^\x00-\x7f]/);
    const parts = decodedParts(raw);
    expect(parts[0]).toContain("Hello 日本語 — café");
    expect(parts[1]).toContain('<meta name="viewport"');
    expect(parts[1]).toContain("Unsubscribe preview");
    expect(parts[1]).toContain('width="272"');
    expect(parts[1]).toContain("width:272px;max-width:100%;height:auto");
  });

  it("selects an unsubscribe hostname by sending domain", () => {
    const configured = JSON.stringify({
      "example.com": "mail.example.com",
      "another-domain.com": "mail.another-domain.com",
    });
    expect(unsubscribeBaseUrl(configured, "EXAMPLE.COM")).toBe("https://mail.example.com");
    expect(() => unsubscribeBaseUrl(configured, "missing.example")).toThrow("No unsubscribe hostname is configured");
  });
});

function decodedParts(raw: string): string[] {
  const parts = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)(?=--)/g)];
  expect(parts).toHaveLength(2);
  return parts.map((part) => {
    const encoded = part[1]!.trim();
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    return new TextDecoder().decode(Uint8Array.from(atob(encoded.replaceAll("\r\n", "")), (char) => char.charCodeAt(0)));
  });
}
