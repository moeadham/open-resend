import type Quill from "quill";
import { Delta } from "quill/core";

// Bring existing saved image rows into the normal inline editing flow.
export function restoreInlineImages(quill: Quill): void {
  quill.clipboard.addMatcher('table[data-email-image-row="two"]', (node) => {
    const delta = new Delta();
    (node as HTMLElement).querySelectorAll("img").forEach((image) => {
      const src = image.getAttribute("src") ?? "";
      if (!src.startsWith("https://")) return;
      const link = image.closest("a")?.getAttribute("href");
      delta.insert({ image: src }, { alt: image.getAttribute("alt") ?? "", width: image.getAttribute("width") ?? "288", ...(link?.startsWith("https://") ? { link } : {}) });
    });
    return delta.insert("\n");
  });
}
