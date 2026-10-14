import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError, appErrorResponse } from "./lib";
import { IMAGE_SIZE_ERROR, MAX_IMAGE_BYTES } from "./image-policy";

type ImagesEnv = Env & { CLOUDFLARE_IMAGES_TOKEN?: string };

// Mounted behind the admin's Access and same-origin middleware.
export const imagesApp = new Hono<{ Bindings: ImagesEnv }>();
imagesApp.onError((error) => appErrorResponse(error));
imagesApp.get("/", (c) => c.json({ enabled: Boolean(c.env.CLOUDFLARE_IMAGES_TOKEN) }));
imagesApp.post("/", bodyLimit({
  maxSize: MAX_IMAGE_BYTES + 64 * 1024,
  onError: (c) => c.json({ message: IMAGE_SIZE_ERROR }, 413),
}), async (c) => {
  const token = c.env.CLOUDFLARE_IMAGES_TOKEN;
  if (!token) throw new AppError(503, "application_error", "Image uploads are not configured. Run npm run deploy -- --configure-images to set up Cloudflare Images.");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) {
    throw new AppError(422, "validation_error", "Choose a PNG, JPEG, GIF, or WebP image up to 10 MB.");
  }
  if (file.size > MAX_IMAGE_BYTES) throw new AppError(413, "validation_error", IMAGE_SIZE_ERROR);
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const signature = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const valid = (file.type === "image/png" && signature.startsWith("89504e470d0a1a0a"))
    || (file.type === "image/jpeg" && signature.startsWith("ffd8ff"))
    || (file.type === "image/gif" && /^(474946383761|474946383961)/.test(signature))
    || (file.type === "image/webp" && signature.startsWith("52494646") && signature.slice(16) === "57454250");
  if (!valid) throw new AppError(422, "validation_error", "Only PNG, JPEG, GIF, and WebP images are supported.");
  const upload = new FormData();
  upload.set("file", file);
  upload.set("requireSignedURLs", "false");
  upload.set("metadata", JSON.stringify({ application: "open-resend" }));
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/images/v1`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: upload,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null) as { success?: boolean; result?: { id?: string; variants?: string[] } } | null;
  if (!response.ok || !body?.success) {
    throw new AppError(502, "application_error", "Cloudflare Images could not upload this file. Check that Images storage is enabled and the token has Images Edit permission.");
  }
  const variants = body.result?.variants ?? [];
  const url = variants.find((variant) => variant.endsWith("/public")) ?? variants[0];
  if (!url || !url.startsWith("https://imagedelivery.net/")) {
    throw new AppError(502, "application_error", "Cloudflare Images returned no public delivery URL. Configure a public image variant in Cloudflare.");
  }
  return c.json({ url }, 201);
});
