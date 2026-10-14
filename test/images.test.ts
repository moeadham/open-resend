import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin";
import { MAX_IMAGE_BYTES } from "../src/image-policy";

const local = { ...env, ENVIRONMENT: "development", ALLOW_LOCAL_ADMIN: "true", CLOUDFLARE_IMAGES_TOKEN: "test-images-secret" };
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
function upload(file = new File([png], "image.png", { type: "image/png" }), origin = "http://localhost") {
  const body = new FormData(); body.set("file", file);
  return new Request("http://localhost/editor/images", { method: "POST", headers: { Origin: origin }, body });
}
afterEach(() => vi.unstubAllGlobals());

describe("editor image uploads", () => {
  it("reports optional configuration without exposing credentials", async () => {
    const response = await adminApp.request("http://localhost/editor/images", {}, local);
    expect(await response.json()).toEqual({ enabled: true });
    const disabled = await adminApp.request("http://localhost/editor/images", {}, { ...local, CLOUDFLARE_IMAGES_TOKEN: undefined });
    expect(await disabled.json()).toEqual({ enabled: false });
  });
  it("requires Access authentication", async () => {
    const response = await adminApp.request("http://localhost/editor/images", {}, { ...local, ALLOW_LOCAL_ADMIN: "false" });
    expect(response.status).toBe(403);
  });
  it("rejects cross-origin uploads", async () => {
    const response = await adminApp.fetch(upload(undefined, "https://evil.example"), local);
    expect(response.status).toBe(403);
  });
  it("explains setup when Images is not configured", async () => {
    const response = await adminApp.fetch(upload(), { ...local, CLOUDFLARE_IMAGES_TOKEN: undefined });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("--configure-images");
  });
  it("uploads public images and returns only the delivery URL", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, result: { id: "image-id", variants: ["https://imagedelivery.net/account/image-id/public"] } }));
    vi.stubGlobal("fetch", request);
    const response = await adminApp.fetch(upload(), local);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ url: "https://imagedelivery.net/account/image-id/public" });
    const options = request.mock.calls[0]![1]!;
    expect(options.headers).toEqual({ Authorization: "Bearer test-images-secret" });
    const form = options.body as FormData;
    expect(form.get("requireSignedURLs")).toBe("false");
    expect((form.get("file") as File).size).toBe(png.length);
  });
  it("rejects disguised files and SVG before calling Cloudflare", async () => {
    const request = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", request);
    for (const file of [new File(["not an image"], "fake.png", { type: "image/png" }), new File(["<svg/>"], "vector.svg", { type: "image/svg+xml" })]) {
      expect((await adminApp.fetch(upload(file), local)).status).toBe(422);
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("bounds upload sizes", async () => {
    const request = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", request);
    const file = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "large.png", { type: "image/png" });
    const response = await adminApp.fetch(upload(file), local);
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("10 MB");
    expect(request).not.toHaveBeenCalled();
  });
  it("accepts images above the old 5 MB limit up to exactly 10 MB", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ success: true, result: { variants: ["https://imagedelivery.net/account/image-id/public"] } }));
    vi.stubGlobal("fetch", request);
    for (const size of [6 * 1024 * 1024, MAX_IMAGE_BYTES]) {
      const bytes = new Uint8Array(size); bytes.set(png);
      const file = new File([bytes], "large.png", { type: "image/png" });
      expect((await adminApp.fetch(upload(file), local)).status).toBe(201);
    }
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("returns safe errors for missing subscriptions or invalid credentials", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: false, errors: [{ message: "upstream detail" }] }, { status: 403 })));
    const response = await adminApp.fetch(upload(), local);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("Images storage");
    expect(body).not.toContain("test-images-secret");
    expect(body).not.toContain("upstream detail");
  });
});
