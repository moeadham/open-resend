import Quill from "quill";
import flatpickr from "flatpickr";

const editor = document.querySelector<HTMLElement>("[data-rich-editor]");
const input = document.querySelector<HTMLTextAreaElement>("#html-input");
if (editor && input) {
  const quill = new Quill(editor, { theme: "snow", placeholder: "Start writing your email…", modules: { toolbar: [[{ header: [1, 2, 3, false] }], ["bold", "italic", "underline", "link"], [{ list: "ordered" }, { list: "bullet" }], ["blockquote", "code-block"], ["clean"]] } });
  if (input.value.trim()) quill.clipboard.dangerouslyPasteHTML(input.value);
  editor.closest("form")?.addEventListener("submit", (event) => {
    if (!quill.getText().trim()) {
      event.preventDefault();
      quill.focus();
      window.alert("Write some email content before saving.");
      return;
    }
    input.value = quill.getSemanticHTML();
  });
}

for (const form of document.querySelectorAll<HTMLFormElement>("form[data-confirm]")) {
  form.addEventListener("submit", (event) => {
    if (!window.confirm(form.dataset.confirm ?? "Are you sure?")) event.preventDefault();
  });
}

for (const form of document.querySelectorAll<HTMLFormElement>("form[data-schedule-form]")) {
  const local = form.querySelector<HTMLInputElement>("[data-schedule-local]");
  if (local) {
    const earliest = new Date(Date.now() + 5 * 60 * 1000);
    const uses24HourTime = Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === false;
    flatpickr(local, {
      altInput: true,
      altFormat: uses24HourTime ? "F j, Y at H:i" : "F j, Y at h:i K",
      dateFormat: "Y-m-d\\TH:i",
      enableTime: true,
      minDate: earliest,
      minuteIncrement: 5,
      time_24hr: uses24HourTime,
    });
  }
  const timezoneLabel = form.querySelector<HTMLElement>("[data-timezone-label]");
  if (timezoneLabel) timezoneLabel.textContent = `Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  form.addEventListener("submit", () => {
    const iso = form.querySelector<HTMLInputElement>("[name=scheduled_at]");
    if (local?.value && iso) iso.value = new Date(local.value).toISOString();
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
  const firstField = dialog.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled)");
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
