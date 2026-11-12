import Quill from "quill";
import { combobox } from "@kiwa-ui/enhance/combobox";
import { datePicker } from "@kiwa-ui/enhance/date-picker";
import { IMAGE_SIZE_ERROR, MAX_IMAGE_BYTES } from "../src/image-policy";
import { enableImageResize } from "./image-resize";
import { restoreInlineImages } from "./image-import";

document.querySelectorAll<HTMLElement>("[data-email-preview]").forEach((preview) => {
  const tabs = Array.from(preview.querySelectorAll<HTMLButtonElement>("[data-preview-tab]"));
  const select = (tab: HTMLButtonElement) => {
    tabs.forEach(item => { item.setAttribute("aria-selected", String(item === tab)); item.tabIndex = item === tab ? 0 : -1; });
    preview.querySelectorAll<HTMLElement>("[data-preview-panel]").forEach(panel => { panel.hidden = panel.dataset.previewPanel !== tab.dataset.previewTab; });
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const target = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null;
      if (target) { event.preventDefault(); select(target); target.focus(); }
    });
  });
});

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
  restoreInlineImages(quill);
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
      image.style.maxWidth = "100%"; image.style.height = "auto"; image.style.display = "inline-block"; image.style.verticalAlign = "middle";
      const width = Number(image.getAttribute("width"));
      if (Number.isFinite(width) && width > 0) image.style.width = `${width}px`;
      if (!image.hasAttribute("alt")) image.setAttribute("alt", "");
    });
    for (const align of ["center", "right", "justify"] as const) {
      content.content.querySelectorAll<HTMLElement>(`.ql-align-${align}`).forEach((element) => { element.style.textAlign = align; });
    }
    input.value = content.innerHTML;
  });
}

// In-page confirmation instead of window.confirm(), which some browsers and embedded views
// suppress (returning false without showing anything), silently cancelling the action.
// The answer is settled from the button clicks / Escape directly rather than the dialog's
// "close" event, which Chromium can hold back indefinitely in an unfocused or throttled tab.
let confirmDialog: HTMLDialogElement | null = null;
let settleConfirmation: ((confirmed: boolean) => void) | null = null;
function finishConfirmation(confirmed: boolean): void {
  const settle = settleConfirmation;
  settleConfirmation = null;
  confirmDialog?.close();
  settle?.(confirmed);
}
function getConfirmDialog(): HTMLDialogElement {
  if (confirmDialog) return confirmDialog;
  const dialog = document.createElement("dialog");
  dialog.className = "modal confirm-modal";
  dialog.innerHTML = `<div class="modal-card"><header class="modal-head"><h2>Are you sure?</h2></header><p class="modal-content" data-confirm-message></p><div class="modal-actions"><button type="button" data-confirm-accept></button><button type="button" data-confirm-cancel>Cancel</button></div></div>`;
  dialog.querySelector("[data-confirm-accept]")!.addEventListener("click", () => finishConfirmation(true));
  dialog.querySelector("[data-confirm-cancel]")!.addEventListener("click", () => finishConfirmation(false));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); finishConfirmation(false); });
  dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); finishConfirmation(false); } });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) finishConfirmation(false); });
  document.body.append(dialog);
  confirmDialog = dialog;
  return dialog;
}

function askConfirmation(message: string, acceptLabel: string, destructive: boolean): Promise<boolean> {
  finishConfirmation(false);
  const dialog = getConfirmDialog();
  dialog.querySelector<HTMLElement>("[data-confirm-message]")!.textContent = message;
  const accept = dialog.querySelector<HTMLButtonElement>("[data-confirm-accept]")!;
  accept.textContent = acceptLabel;
  accept.className = destructive ? "danger" : "primary";
  dialog.showModal();
  dialog.querySelector<HTMLButtonElement>("[data-confirm-cancel]")!.focus();
  return new Promise((resolve) => { settleConfirmation = resolve; });
}

for (const form of document.querySelectorAll<HTMLFormElement>("form[data-confirm]")) {
  form.addEventListener("submit", async (event) => {
    if (form.dataset.confirmed === "true") {
      delete form.dataset.confirmed;
      return;
    }
    event.preventDefault();
    const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
    const label = (submitter && buttonLabel(submitter)) || "Confirm";
    const destructive = Boolean(submitter?.matches(".danger, .destructive-menu-item"));
    if (!(await askConfirmation(form.dataset.confirm ?? "Are you sure?", label, destructive))) return;
    form.dataset.confirmed = "true";
    form.requestSubmit(submitter);
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy-value], [data-copy-target]")) {
  button.addEventListener("click", async () => {
    const target = button.dataset.copyTarget ? document.getElementById(button.dataset.copyTarget) : null;
    const value = button.dataset.copyValue ?? (target instanceof HTMLInputElement ? target.value : target?.textContent ?? "");
    if (!value) return;
    const copied = await copyText(value, button);
    const label = button.querySelector<HTMLElement>("[data-copy-text]");
    const originalLabel = label?.textContent ?? "";
    if (label) label.textContent = copied ? "Copied" : "Copy failed";
    button.dataset.copied = String(copied);
    if (!copied && target instanceof HTMLInputElement) {
      // Leave the value selected so the user can copy it manually.
      target.type = "text";
      target.focus();
      target.select();
    }
    const menu = button.closest<HTMLElement>("[data-action-menu]");
    if (copied && menu && "hidePopover" in menu) menu.hidePopover();
    window.setTimeout(() => {
      if (label) label.textContent = originalLabel;
      delete button.dataset.copied;
    }, 1600);
  });
}

async function copyText(value: string, origin: HTMLElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Clipboard API is missing (non-secure context) or denied; fall back to execCommand.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  // While a modal <dialog> or popover is open, everything outside it is inert and cannot be
  // selected, so the helper must live inside the same top-layer element as the button.
  const host = origin.closest<HTMLElement>("dialog, [popover]") ?? document.body;
  host.append(textarea);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    // An inert helper can't take focus; execCommand would then report success while copying nothing.
    copied = document.activeElement === textarea && document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  previousFocus?.focus();
  return copied;
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-secret-toggle]")) {
  button.addEventListener("click", () => {
    const field = button.closest<HTMLElement>("[data-secret-field]")?.querySelector<HTMLInputElement>("[data-secret-key]");
    if (!field) return;
    const reveal = field.type === "password";
    field.type = reveal ? "text" : "password";
    button.setAttribute("aria-pressed", String(reveal));
    button.setAttribute("aria-label", `${reveal ? "Hide" : "Show"} ${button.dataset.secretLabel ?? "API key"}`);
    if (button.dataset.secretLabel) button.textContent = reveal ? "Hide" : "Show";
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

// Keep the event picker inside the modal: a body portal is inert behind a dialog.
for (const form of document.querySelectorAll<HTMLFormElement>("[data-webhook-form]")) {
  const endpoint = form.querySelector<HTMLInputElement>("[name=endpoint]")!;
  const value = form.querySelector<HTMLInputElement>("[name=event]")!;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const picker = form.querySelector<HTMLButtonElement>("[data-webhook-event-trigger]")!;
  const menu = form.querySelector<HTMLElement>("#webhook-event-options")!;
  const search = form.querySelector<HTMLInputElement>("[data-webhook-event-search]")!;
  const option = form.querySelector<HTMLButtonElement>("[data-webhook-event-option]")!;
  const empty = form.querySelector<HTMLElement>("[data-webhook-event-empty]")!;
  const close = () => { menu.hidden = true; picker.setAttribute("aria-expanded", "false"); };
  const update = () => { picker.disabled = !endpoint.value || !endpoint.validity.valid; submit.disabled = picker.disabled || value.value !== "email.received"; if (picker.disabled) close(); };
  picker.addEventListener("click", () => { const open = menu.hidden; menu.hidden = !open; picker.setAttribute("aria-expanded", String(open)); if (open) search.focus(); });
  search.addEventListener("input", () => { option.hidden = !"email.received".includes(search.value.toLowerCase()); empty.hidden = !option.hidden; });
  option.addEventListener("click", () => { value.value = "email.received"; option.setAttribute("aria-selected", "true"); form.querySelector<HTMLElement>("[data-webhook-event-label]")!.textContent = "email.received"; close(); picker.focus(); update(); });
  menu.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); picker.focus(); } else if (event.key === "ArrowDown" && !option.hidden) { event.preventDefault(); option.focus(); } else if (event.key === "Enter" && event.target === search && !option.hidden) { event.preventDefault(); option.click(); } });
  form.addEventListener("input", update);
  document.addEventListener("pointerdown", event => { if (event.target instanceof Node && !form.querySelector("[data-webhook-event-picker]")?.contains(event.target)) close(); });
  form.addEventListener("submit", event => { if (value.value !== "email.received") event.preventDefault(); });
  update();
}

// ---- Submit feedback -------------------------------------------------------
// Admin forms are plain POST + redirect, so without help the only signal is the page reloading.
// While a request is in flight the clicked button shows a busy state (and repeat submits are
// ignored); after the redirect a short toast confirms what happened.

const NOTICE_KEY = "open-resend:notice";
const PAST_TENSE: Record<string, string> = {
  add: "added", create: "created", save: "saved", update: "updated", delete: "deleted", remove: "removed",
  revoke: "revoked", send: "sent", cancel: "cancelled", sync: "synced", enable: "enabled", disable: "disabled",
  schedule: "scheduled", replay: "replayed",
};

function buttonLabel(button: HTMLElement): string {
  const clone = button.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("kbd, svg, .sr-only").forEach((node) => node.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim().replace(/^[^\p{L}]+/u, "");
}

function successMessage(form: HTMLFormElement, submitter: HTMLElement | null): string | null {
  const template = submitter?.dataset.success ?? form.dataset.success;
  if (template !== undefined) {
    return template.replace(/\{(\w+)\}/g, (_, name: string) => {
      const field = form.elements.namedItem(name);
      return field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement ? field.value : "";
    }) || null;
  }
  const label = submitter ? buttonLabel(submitter) : "";
  const [verb = "", ...rest] = label.split(" ");
  const past = PAST_TENSE[verb.toLowerCase()];
  if (!past) return null;
  const object = rest.join(" ");
  if (!object || /^(and|&|now)\b/i.test(object)) return `${past[0].toUpperCase()}${past.slice(1)}.`;
  return `${object[0].toUpperCase()}${object.slice(1)} ${past}.`;
}

function setBusy(button: HTMLElement | null, busy: boolean): void {
  if (!button) return;
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
  const method = (event.submitter?.getAttribute("formmethod") ?? form.method).toLowerCase();
  if (method === "dialog") return;
  if (form.dataset.submitting === "true") {
    event.preventDefault();
    return;
  }
  // Custom pickers keep their value in a hidden input, which native `required` ignores.
  const required = form.dataset.requireField ? form.elements.namedItem(form.dataset.requireField) : null;
  if (required instanceof HTMLInputElement && !required.value) {
    event.preventDefault();
    showToast(form.dataset.requireMessage ?? "Fill in the required field first.", "error");
    return;
  }
  form.dataset.submitting = "true";
  const submitter = event.submitter instanceof HTMLElement ? event.submitter : form.querySelector<HTMLElement>("button:not([type=button]), [type=submit]");
  setBusy(submitter, true);
  if (method === "post") {
    const message = successMessage(form, submitter);
    try {
      if (message) sessionStorage.setItem(NOTICE_KEY, message);
      else sessionStorage.removeItem(NOTICE_KEY);
    } catch { /* storage unavailable: skip the toast */ }
  }
});

// Back/forward cache restores the page as it was when we left it, busy buttons included.
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  for (const form of document.querySelectorAll<HTMLFormElement>("form[data-submitting]")) delete form.dataset.submitting;
  for (const button of document.querySelectorAll<HTMLElement>("[aria-busy=true]")) setBusy(button, false);
});

function showToast(message: string, tone: "success" | "error" = "success"): void {
  let region = document.querySelector<HTMLElement>(".toast-region");
  if (!region) {
    region = document.createElement("div");
    region.className = "toast-region";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.append(region);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${tone}`;
  toast.textContent = message;
  region.append(toast);
  window.setTimeout(() => {
    toast.dataset.leaving = "true";
    window.setTimeout(() => toast.remove(), 200);
  }, 4000);
}

{
  let notice: string | null = null;
  try {
    notice = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
  } catch { /* storage unavailable */ }
  // The admin error page renders its own message; only confirm actions that actually succeeded.
  if (notice && !document.querySelector(".panel.error")) showToast(notice);
}

for (const button of document.querySelectorAll<HTMLElement>("[data-history-back]")) {
  button.addEventListener("click", () => {
    if (history.length > 1) history.back();
    else window.location.assign("/");
  });
}
