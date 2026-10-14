import Quill, { Parchment } from "quill";
import { Delta } from "quill/core";

export function registerImageRows(): void {
  Quill.register(new Parchment.Attributor("image-row", "data-image-row", { scope: Parchment.Scope.BLOCK, whitelist: ["two"] }), true);
}

function imageLine(image: HTMLImageElement): HTMLElement | null {
  const line = image.closest<HTMLElement>(".ql-editor > p");
  return line && !line.textContent?.trim() && line.querySelectorAll("img").length === 1 ? line : null;
}

function pairLines(image: HTMLImageElement): [HTMLElement, HTMLElement] | null {
  const line = imageLine(image);
  if (!line) return null;
  for (const direction of ["nextElementSibling", "previousElementSibling"] as const) {
    let other = line[direction];
    while (other?.tagName === "P" && !other.textContent?.trim() && !other.querySelector("img")) other = other[direction];
    const candidate = other?.querySelector("img");
    if (candidate instanceof HTMLImageElement && imageLine(candidate) === other) {
      return direction === "nextElementSibling" ? [line, other as HTMLElement] : [other as HTMLElement, line];
    }
  }
  return null;
}

export function canPairImage(image: HTMLImageElement): boolean { return Boolean(pairLines(image)); }

export function changeImageRow(quill: Quill, image: HTMLImageElement, stack: boolean): HTMLImageElement | null {
  const row = image.closest<HTMLElement>('[data-image-row="two"]');
  const lines = stack ? row && [row, row] : pairLines(image);
  if (!lines) return null;
  const first = Quill.find(lines[0]!); const last = Quill.find(lines[1]!);
  if (!first || first instanceof Quill || !last || last instanceof Quill) return null;
  const start = quill.getIndex(first);
  const end = quill.getIndex(last) + last.length();
  const images = stack ? Array.from(row!.querySelectorAll("img")) : lines.map((line) => line!.querySelector("img")!);
  let content = new Delta();
  for (const item of images) {
    const blot = Quill.find(item);
    if (!blot || blot instanceof Quill) return null;
    const imageDelta = quill.getContents(quill.getIndex(blot), 1);
    if (!stack) imageDelta.ops.forEach((op) => { op.attributes = { ...op.attributes, width: String(Math.min(Number(item.getAttribute("width")) || 288, 288)) }; delete op.attributes.height; });
    content = content.concat(imageDelta);
    if (stack) content.insert("\n");
  }
  if (!stack) content.insert("\n", { "image-row": "two" });
  quill.updateContents(new Delta().retain(start).delete(end - start).concat(content), "user");
  quill.setSelection(start, 0, "silent");
  return Array.from(quill.root.querySelectorAll<HTMLImageElement>("img")).find((item) => {
    const blot = Quill.find(item); return blot && !(blot instanceof Quill) && quill.getIndex(blot) >= start;
  }) ?? null;
}

export function restoreImageRows(quill: Quill): void {
  quill.clipboard.addMatcher('table[data-email-image-row="two"]', (node) => {
    const delta = new Delta();
    const images = (node as HTMLElement).querySelectorAll("img");
    images.forEach((image) => {
      const src = image.getAttribute("src") ?? "";
      if (!src.startsWith("https://")) return;
      const link = image.closest("a")?.getAttribute("href");
      delta.insert({ image: src }, { alt: image.getAttribute("alt") ?? "", width: image.getAttribute("width") ?? "288", ...(link?.startsWith("https://") ? { link } : {}) });
    });
    return delta.insert("\n", images.length === 2 ? { "image-row": "two" } : {});
  });
}

export function serializeImageRows(content: DocumentFragment): void {
  content.querySelectorAll<HTMLElement>('[data-image-row="two"]').forEach((row) => {
    const images = row.querySelectorAll("img");
    if (images.length !== 2 || row.textContent?.trim()) { row.removeAttribute("data-image-row"); return; }
    const table = document.createElement("table");
    table.setAttribute("role", "presentation"); table.setAttribute("width", "100%");
    table.setAttribute("cellpadding", "0"); table.setAttribute("cellspacing", "0"); table.setAttribute("border", "0");
    table.dataset.emailImageRow = "two"; table.className = "email-image-row";
    table.style.cssText = "width:100%;border-collapse:collapse;table-layout:fixed;margin:16px 0";
    const tr = table.createTBody().insertRow();
    images.forEach((image) => {
      const cell = tr.insertCell(); cell.className = "email-image-cell";
      cell.setAttribute("width", "50%"); cell.setAttribute("valign", "top");
      cell.style.cssText = "width:50%;vertical-align:top;padding:0 6px";
      const link = image.closest("a");
      if (link) { const copy = link.cloneNode(false) as HTMLAnchorElement; copy.append(image.cloneNode(true)); cell.append(copy); }
      else cell.append(image.cloneNode(true));
    });
    row.replaceWith(table);
  });
}
