import Quill from "quill";
import { canPairImage, changeImageRow } from "./image-layout";

export function enableImageResize(quill: Quill, editor: HTMLElement): void {
  let selected: HTMLImageElement | null = null;
  const controls = document.createElement("div");
  controls.className = "editor-image-controls";
  controls.hidden = true;
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Image size");
  const label = document.createElement("label");
  label.textContent = "Image width";
  const widthInput = document.createElement("input");
  widthInput.type = "number";
  widthInput.min = "24"; widthInput.max = "600"; widthInput.step = "1";
  widthInput.setAttribute("aria-label", "Image width in pixels");
  label.append(widthInput, " px");
  controls.append(label);
  for (const [text, width] of [["25%", 150], ["50%", 300], ["Full width", 600]] as const) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = text;
    button.addEventListener("click", () => resize(width));
    controls.append(button);
  }
  const pairButton = document.createElement("button");
  pairButton.type = "button"; pairButton.textContent = "Side by side";
  const stackButton = document.createElement("button");
  stackButton.type = "button"; stackButton.textContent = "Stack images";
  controls.append(pairButton, stackButton);
  for (const [button, stack] of [[pairButton, false], [stackButton, true]] as const) button.addEventListener("click", () => {
    if (!selected) return;
    const result = changeImageRow(quill, selected, stack);
    if (result) {
      selected = result; controls.hidden = false; outline.hidden = false;
      observer.disconnect(); observer.observe(selected); observer.observe(quill.root); position();
    }
  });
  editor.before(controls);

  const outline = document.createElement("div");
  outline.className = "editor-image-outline"; outline.hidden = true;
  const handle = document.createElement("button");
  handle.type = "button"; handle.className = "editor-image-handle";
  handle.setAttribute("aria-label", "Resize image. Drag or use left and right arrow keys.");
  handle.title = "Drag to resize image"; handle.textContent = "↘";
  outline.append(handle); document.body.append(outline);

  function position() {
    if (!selected?.isConnected) { hide(); return; }
    const rect = selected.getBoundingClientRect();
    Object.assign(outline.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    if (document.activeElement !== widthInput) widthInput.value = selected.getAttribute("width") ?? String(Math.round(rect.width));
    const row = selected.closest('[data-image-row="two"]');
    pairButton.hidden = Boolean(row); pairButton.disabled = !canPairImage(selected);
    pairButton.title = pairButton.disabled ? "Add another image immediately above or below this image first" : "Place this image beside its neighboring image";
    stackButton.hidden = !row;
  }
  function hide() { selected = null; controls.hidden = true; outline.hidden = true; observer.disconnect(); }
  function resize(width: number) {
    if (!selected || !Number.isFinite(width)) return;
    const blot = Quill.find(selected);
    if (!blot || blot instanceof Quill) return;
    const index = quill.getIndex(blot);
    quill.formatText(index, 1, { width: String(Math.max(24, Math.min(600, Math.round(width)))), height: false }, "user");
    position();
  }
  const observer = new ResizeObserver(position);
  editor.addEventListener("click", (event) => {
    if (!(event.target instanceof HTMLImageElement)) return;
    selected = event.target;
    controls.hidden = false; outline.hidden = false;
    observer.disconnect(); observer.observe(selected); observer.observe(quill.root);
    position();
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && event.target !== selected && !controls.contains(event.target) && !outline.contains(event.target)) hide();
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); });
  widthInput.addEventListener("change", () => {
    resize(widthInput.valueAsNumber);
    widthInput.value = selected?.getAttribute("width") ?? "";
  });
  widthInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); resize(widthInput.valueAsNumber); widthInput.blur(); }
  });
  let drag: { pointerId: number; x: number; width: number } | null = null;
  handle.addEventListener("pointerdown", (event) => {
    if (!selected) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, x: event.clientX, width: selected.getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag?.pointerId === event.pointerId) { event.preventDefault(); resize(drag.width + event.clientX - drag.x); }
  });
  const stopDrag = () => { drag = null; };
  handle.addEventListener("pointerup", stopDrag); handle.addEventListener("pointercancel", stopDrag);
  handle.addEventListener("keydown", (event) => {
    if (!selected || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    resize(Number(selected.getAttribute("width") ?? selected.getBoundingClientRect().width) + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 1 : 10));
  });
  window.addEventListener("scroll", () => { if (selected) position(); }, true);
  window.addEventListener("resize", () => { if (selected) position(); });
  quill.on("text-change", () => { if (selected) position(); });
}
