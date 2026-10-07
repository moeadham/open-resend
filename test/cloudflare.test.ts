import { describe, expect, it, vi } from "vitest";
import { listEnabledSendingDomains } from "../src/cloudflare";

function response(result: unknown, resultInfo?: { page: number; total_pages: number }): Response {
  return Response.json({ success: true, result, result_info: resultInfo });
}

describe("Cloudflare Email Sending discovery", () => {
  it("lists enabled exact sending domains across zones and skips wildcard entries", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ id: "zone-a", name: "example.com" }, { id: "zone-b", name: "example.net" }]))
      .mockResolvedValueOnce(response([
        { name: "example.com", enabled: true },
        { name: "news.example.com", enabled: false },
        { name: "*.example.com", enabled: true },
      ]))
      .mockResolvedValueOnce(response([{ name: "mail.example.net", enabled: true }]));

    await expect(listEnabledSendingDomains("account-id", "secret", request)).resolves.toEqual({
      domains: ["example.com", "mail.example.net"],
      skippedWildcards: 1,
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]![0].toString()).toContain("/accounts/account-id/email/sending/zones");
    expect(request.mock.calls[0]![1]).toEqual({ headers: { Authorization: "Bearer secret" } });
  });

  it("reads every Cloudflare result page", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ id: "zone-a", name: "example.com" }], { page: 1, total_pages: 2 }))
      .mockResolvedValueOnce(response([{ id: "zone-b", name: "example.net" }], { page: 2, total_pages: 2 }))
      .mockResolvedValueOnce(response([{ name: "example.com", enabled: true }]))
      .mockResolvedValueOnce(response([{ name: "example.net", enabled: true }]));

    const result = await listEnabledSendingDomains("account-id", "secret", request);
    expect(result.domains).toEqual(["example.com", "example.net"]);
    expect(request.mock.calls[1]![0].toString()).toContain("page=2");
  });

  it("returns a useful Cloudflare API error", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      success: false,
      errors: [{ message: "Missing Email Sending Read permission" }],
    }, { status: 403 }));

    await expect(listEnabledSendingDomains("account-id", "secret", request))
      .rejects.toThrow("Missing Email Sending Read permission");
  });
});
