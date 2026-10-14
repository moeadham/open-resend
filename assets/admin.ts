import Quill from "quill";
import { combobox } from "@kiwa-ui/enhance/combobox";
import { datePicker } from "@kiwa-ui/enhance/date-picker";
import { IMAGE_SIZE_ERROR, MAX_IMAGE_BYTES } from "../src/image-policy";
import { enableImageResize } from "./image-resize";
import { registerImageRows, restoreImageRows, serializeImageRows } from "./image-layout";

registerImageRows();

const editor = document.querySelector<HTMLElement>("[data-rich-editor]");
const input = document.querySelector<HTMLTextAreaElement>("#html-input");
if (editor && input) {
  let uploading = false;
  const status = document.createElement("div");
  status.className = "editor-upload-status";
  status.setAttribute("role", "status");
  status.hidden = true;
  function showUploadStatus(message: string, error = false) {
    status.replaceChildren();
    status.hidden = !message;
    status.dataset.error = String(error);
    status.setAttribute("role", error ? "alert" : "status");
    status.setAttribute("aria-live", error ? "assertive" : "polite");
    if (error) {
      const title = document.createElement("strong");
      title.textContent = "Image upload failed";
      status.append(title);
    }
    const description = document.createElement("span");
    description.textContent = message;
    status.append(description);
    if (error) {
      status.tabIndex = -1;
      status.scrollIntoView({ block: "nearest", behavior: "smooth" });
      status.focus({ preventScroll: true });
    }
  }
  const quill = new Quill(editor, { theme: "snow", placeholder: "Start writing your email…", modules: {
    toolbar: { container: [[{ header: [1, 2, 3, false] }], ["bold", "italic", "underline", "link", "image"], [{ align: [false, "center", "right", "justify"] }], [{ list: "ordered" }, { list: "bullet" }], ["blockquote", "code-block"], ["clean"]], handlers: {
      image: () => {
        const range = quill.getSelection(true);
        const picker = document.createElement("input");
        picker.type = "file";
        picker.accept = "image/png,image/jpeg,image/gif,image/webp";
        picker.onchange = () => { if (picker.files?.length) void uploadImages(range, Array.from(picker.files)); };
        picker.click();
      },
    } },
    uploader: { mimetypes: ["image/png", "image/jpeg", "image/gif", "image/webp"], handler: (range: { index: number; length: number }, files: File[]) => { void uploadImages(range, files); } },
  } });
  // Immediately below Quill's toolbar, not beneath the entire email body.
  editor.before(status);
  enableImageResize(quill, editor);
  restoreImageRows(quill);
  const alignment = editor.parentElement?.querySelector(".ql-align");
  alignment?.querySelector(".ql-picker-label")?.setAttribute("aria-label", "Text alignment");
  alignment?.querySelectorAll<HTMLElement>(".ql-picker-item").forEach((item) => {
    const name = item.dataset.value === "justify" ? "Justify (full width)" : item.dataset.value === "center" ? "Center" : item.dataset.value === "right" ? "Right" : "Left";
    item.title = name; item.setAttribute("aria-label", name);
  });
  const imageButton = editor.parentElement?.querySelector<HTMLButtonElement>(".ql-image");
  if (imageButton) { imageButton.title = "Insert image"; imageButton.setAttribute("aria-label", "Insert image"); }
  void fetch("/editor/images").then(async (response) => {
    const result = await response.json();
    if (!result.enabled && !uploading && status.hidden) showUploadStatus("Image uploads need Cloudflare Images. Run npm run deploy -- --configure-images to enable them.");
  }).catch(() => { if (!uploading && status.hidden) showUploadStatus("Could not check image upload availability. Try inserting an image to retry."); });
  async function uploadImages(range: { index: number; length: number }, files: File[]) {
    if (uploading) return;
    uploading = true;
    const saveButtons = editor!.closest("form")?.querySelectorAll<HTMLButtonElement>('button:not([type]),button[type="submit"]');
    saveButtons?.forEach((button) => { button.disabled = true; });
    try {
      let index = Math.min(range.index, quill.getLength() - 1);
      for (const file of files) {
        if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB): ${IMAGE_SIZE_ERROR}`);
        const alt = window.prompt("Image description (alt text, optional):", "");
        if (alt === null) continue;
        showUploadStatus(`Uploading ${file.name}…`);
        const form = new FormData(); form.set("file", file);
        const response = await fetch("/editor/images", { method: "POST", body: form });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result?.url) throw new Error(result?.message ?? "Image upload failed. Please try again.");
        index = Math.min(index, quill.getLength() - 1);
        quill.insertEmbed(index, "image", result.url, "user");
        if (alt) quill.formatText(index, 1, "alt", alt, "user");
        index += 1;
        quill.setSelection(index, 0, "silent");
      }
      showUploadStatus("");
    } catch (error) { showUploadStatus(error instanceof Error ? error.message : "Please try again.", true); }
    finally { uploading = false; saveButtons?.forEach((button) => { button.disabled = false; }); }
  }
  // Never retain Quill's default inline base64 images from pasted HTML.
  quill.clipboard.addMatcher("IMG", (node, delta) => {
    const src = (node as HTMLImageElement).getAttribute("src") ?? "";
    if (!src.startsWith("https://")) {
      showUploadStatus("Use Insert image or paste an image file to upload it. Inline images are not supported.", true);
      return delta.slice(0, 0);
    }
    return delta;
  });
  if (input.value.trim()) quill.clipboard.dangerouslyPasteHTML(input.value);
  editor.closest("form")?.addEventListener("submit", (event) => {
    if (uploading || (!quill.getText().trim() && !quill.root.querySelector("img"))) {
      event.preventDefault();
      quill.focus();
      window.alert("Write some email content before saving.");
      return;
    }
    const content = document.createElement("template");
    content.innerHTML = quill.getSemanticHTML();
    content.content.querySelectorAll("img").forEach((image) => {
      image.style.maxWidth = "100%"; image.style.height = "auto"; image.style.display = "block";
      const width = Number(image.getAttribute("width"));
      if (Number.isFinite(width) && width > 0) image.style.width = `${width}px`;
      if (!image.hasAttribute("alt")) image.setAttribute("alt", "");
    });
    for (const align of ["center", "right", "justify"] as const) {
      content.content.querySelectorAll<HTMLElement>(`.ql-align-${align}`).forEach((element) => { element.style.textAlign = align; });
    }
    serializeImageRows(content.content);
    input.value = content.innerHTML;
  });
}

for (const form of document.querySelectorAll<HTMLFormElement>("form[data-confirm]")) {
  form.addEventListener("submit", (event) => {
    if (!window.confirm(form.dataset.confirm ?? "Are you sure?")) event.preventDefault();
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy-value], [data-copy-target]")) {
  button.addEventListener("click", async () => {
    const target = button.dataset.copyTarget ? document.getElementById(button.dataset.copyTarget) : null;
    const value = button.dataset.copyValue ?? (target instanceof HTMLInputElement ? target.value : "");
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    const label = button.querySelector<HTMLElement>("[data-copy-text]");
    const originalLabel = label?.textContent ?? "";
    if (label) label.textContent = "Copied";
    button.dataset.copied = "true";
    const menu = button.closest<HTMLElement>("[data-action-menu]");
    if (menu && "hidePopover" in menu) menu.hidePopover();
    window.setTimeout(() => {
      if (label) label.textContent = originalLabel;
      delete button.dataset.copied;
    }, 1600);
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-secret-toggle]")) {
  button.addEventListener("click", () => {
    const field = button.closest<HTMLElement>("[data-secret-field]")?.querySelector<HTMLInputElement>("[data-secret-key]");
    if (!field) return;
    const reveal = field.type === "password";
    field.type = reveal ? "text" : "password";
    button.setAttribute("aria-pressed", String(reveal));
    button.setAttribute("aria-label", reveal ? "Hide API key" : "Show API key");
  });
}

for (const trigger of document.querySelectorAll<HTMLButtonElement>("[data-action-menu-trigger]")) {
  trigger.addEventListener("click", () => {
    const menuId = trigger.getAttribute("popovertarget");
    const menu = menuId ? document.getElementById(menuId) : null;
    if (!menu) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = 176;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth))}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    window.requestAnimationFrame(() => {
      if (rect.bottom + 6 + menu.offsetHeight > window.innerHeight - 8) menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 6)}px`;
    });
  });
}

datePicker();
combobox();

for (const form of document.querySelectorAll<HTMLFormElement>("form[data-schedule-form]")) {
  const dateInput = form.querySelector<HTMLInputElement>("[data-schedule-date]");
  const timeInput = form.querySelector<HTMLSelectElement>("[data-schedule-time]");
  const summary = form.querySelector<HTMLElement>("[data-schedule-summary]");
  const error = form.querySelector<HTMLElement>("[data-schedule-error]");
  const picker = form.querySelector<HTMLElement>("[data-date-picker]");
  const timezoneLabel = form.querySelector<HTMLElement>("[data-timezone-label]");
  if (timezoneLabel) timezoneLabel.textContent = `Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;

  const updateSummary = (): void => {
    if (!summary || !dateInput?.value || !timeInput?.value) return;
    const selected = new Date(`${dateInput.value}T${timeInput.value}:00`);
    summary.textContent = selected.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    if (error) error.textContent = "";
  };

  const selectDate = (target: Date): void => {
    if (!picker) return;
    const targetMonth = target.getFullYear() * 12 + target.getMonth();
    const currentMonth = Number(picker.dataset.datePickerYear) * 12 + Number(picker.dataset.datePickerMonth);
    const direction = targetMonth >= currentMonth ? "[data-date-picker-next]" : "[data-date-picker-prev]";
    for (let step = 0; step < Math.abs(targetMonth - currentMonth); step += 1) picker.querySelector<HTMLButtonElement>(direction)?.click();
    const value = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
    picker.querySelector<HTMLButtonElement>(`[data-date-picker-day="${value}"]`)?.click();
  };

  for (const preset of form.querySelectorAll<HTMLButtonElement>("[data-schedule-preset]")) {
    preset.addEventListener("click", () => {
      const target = new Date();
      target.setSeconds(0, 0);
      if (preset.dataset.schedulePreset === "next-monday") {
        const daysUntilMonday = ((8 - target.getDay()) % 7) || 7;
        target.setDate(target.getDate() + daysUntilMonday);
        if (timeInput) timeInput.value = "09:00";
      } else {
        target.setDate(target.getDate() + 1);
        if (timeInput) timeInput.value = preset.dataset.schedulePreset === "tomorrow-afternoon" ? "15:00" : "09:00";
      }
      selectDate(target);
      updateSummary();
      for (const item of form.querySelectorAll("[data-schedule-preset]")) item.removeAttribute("data-active");
      preset.dataset.active = "true";
    });
  }

  picker?.addEventListener("date-change", () => {
    for (const item of form.querySelectorAll("[data-schedule-preset]")) item.removeAttribute("data-active");
    updateSummary();
  });
  timeInput?.addEventListener("change", updateSummary);

  form.addEventListener("submit", (event) => {
    const iso = form.querySelector<HTMLInputElement>("[name=scheduled_at]");
    if (!dateInput?.value || !timeInput?.value || !iso) {
      event.preventDefault();
      if (error) error.textContent = "Choose a date before scheduling.";
      return;
    }
    const selected = new Date(`${dateInput.value}T${timeInput.value}:00`);
    if (selected.getTime() < Date.now() + 5 * 60 * 1000) {
      event.preventDefault();
      if (error) error.textContent = "Choose a time at least five minutes from now.";
      return;
    }
    iso.value = selected.toISOString();
  });
}

for (const row of document.querySelectorAll<HTMLElement>("[data-row-href]")) {
  const open = (): void => {
    const href = row.dataset.rowHref;
    if (href) window.location.assign(href);
  };
  row.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a,button,input,select,textarea,form")) return;
    open();
  });
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
}

function openDialog(id: string): void {
  const dialog = document.getElementById(id);
  if (!(dialog instanceof HTMLDialogElement)) return;
  dialog.showModal();
  const firstField = dialog.querySelector<HTMLElement>("input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)");
  firstField?.focus();
}

for (const trigger of document.querySelectorAll<HTMLElement>("[data-modal-open]")) {
  trigger.addEventListener("click", () => openDialog(trigger.dataset.modalOpen ?? ""));
}

for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.modal")) {
  for (const close of dialog.querySelectorAll<HTMLElement>("[data-modal-close]")) {
    close.addEventListener("click", () => dialog.close());
  }
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      dialog.querySelector<HTMLFormElement>("form")?.requestSubmit();
    }
  });
  if (dialog.dataset.autoOpen === "true") openDialog(dialog.id);
}
