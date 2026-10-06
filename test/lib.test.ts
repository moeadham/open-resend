import { describe, expect, it } from "vitest";
import { buildCampaignMime } from "../src/delivery";
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
      sender_name: "Example News",
      sender_reply_to: "replies@example.com",
      sender_domain: "example.com",
      postal_address: "1 Main Street\nTokyo",
      sender_active: 1,
    };
    const url = "https://api.example.com/unsubscribe/token";
    const raw = buildCampaignMime(detail, url);

    expect(raw).toContain(`List-Unsubscribe: <${url}>`);
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(raw).toContain("Reply-To: <replies@example.com>");
    expect(raw).toContain("1 Main Street");
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("text/html"));
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
