import type { FC } from "hono/jsx";

type DatePickerProps = {
  name: string;
  minDate?: string;
};

const days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function dateString(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export const DatePicker: FC<DatePickerProps> = ({ name, minDate }) => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: Array<number | null> = [...Array<null>(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, index) => index + 1)];
  while (cells.length % 7) cells.push(null);

  return <div class="date-picker" data-date-picker data-date-picker-mode="single" data-date-picker-month={month} data-date-picker-year={year} data-date-picker-min={minDate}>
    <input type="hidden" name={name} data-date-picker-input data-schedule-date value=""/>
    <div class="date-picker-head">
      <button type="button" data-date-picker-prev aria-label="Previous month">‹</button>
      <strong data-date-picker-title>{new Date(Date.UTC(year, month)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</strong>
      <button type="button" data-date-picker-next aria-label="Next month">›</button>
    </div>
    <div class="date-picker-weekdays">{days.map((day) => <span>{day}</span>)}</div>
    <div class="date-picker-grid" data-date-picker-grid>{cells.map((day, index) => day === null
      ? <div class="date-picker-empty" aria-hidden="true" data-cell={index}></div>
      : <div><button
          type="button"
          data-date-picker-day={dateString(year, month, day)}
          data-today={dateString(year, month, day) === now.toISOString().slice(0, 10) ? "true" : undefined}
          data-disabled={minDate && dateString(year, month, day) < minDate ? "true" : undefined}
        >{day}</button></div>)}</div>
  </div>;
};
