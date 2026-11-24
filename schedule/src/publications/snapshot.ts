import type { PublicationSnapshot } from "../db/schema.js";
import { calendarDayText, cellText, columnLabel, type RenderPublicationInput } from "./render.js";

/**
 * The structured snapshot of one publication (Issue #48): from
 * the very input the document renderer consumes, the period as
 * it was issued — every date of the range in order, that date's
 * day type code, and every view column's cell text in column
 * order, the text exactly as the document prints it (cellText
 * shares the renderer's own composition, so the two cannot
 * drift apart). Stored beside the document at publish time;
 * the version diff (diff.ts) reads these snapshots, never the
 * HTML. A publication issued before snapshots existed carries
 * none, and cannot be diffed.
 *
 * The month calendar (Issue #49) has no per-column cells to
 * snapshot: its days carry the one cell the calendar prints —
 * the day's full entry text (calendarDayText) under the fixed
 * column id "calendar" — so a calendar version's diff still
 * reads day by day, in the same shape as every other layout's.
 */
export function buildPublicationSnapshot(input: RenderPublicationInput): PublicationSnapshot {
  const { range, context: ctx } = input;
  const columns = [...range.view.columns].sort((a, b) => a.sort - b.sort);
  const calendar = range.view.layout === "calendar_grid";
  return {
    version: 1,
    days: range.days.map((day) => ({
      date: day.date,
      dayType: typeof day.day["dayType"] === "string" ? (day.day["dayType"] as string) : "",
      cells: calendar
        ? [{ columnId: "calendar", label: "予定", text: calendarDayText(day, columns, ctx) }]
        : columns.map((column) => ({
            columnId: column.id,
            label: columnLabel(column, ctx),
            text: cellText(day, column, columns, ctx),
          })),
    })),
  };
}
