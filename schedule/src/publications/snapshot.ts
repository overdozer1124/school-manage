import type { PublicationSnapshot } from "../db/schema.js";
import { cellText, columnLabel, type RenderPublicationInput } from "./render.js";

/**
 * The structured snapshot of one publication (Issue #48): from
 * the very input the document renderer consumes, the month as
 * it was issued — every date of the range in order, that date's
 * day type code, and every view column's cell text in column
 * order, the text exactly as the document prints it (cellText
 * shares the renderer's own composition, so the two cannot
 * drift apart). Stored beside the document at publish time;
 * the version diff (diff.ts) reads these snapshots, never the
 * HTML. A publication issued before snapshots existed carries
 * none, and cannot be diffed.
 */
export function buildPublicationSnapshot(input: RenderPublicationInput): PublicationSnapshot {
  const { range, context: ctx } = input;
  const columns = [...range.view.columns].sort((a, b) => a.sort - b.sort);
  return {
    version: 1,
    days: range.days.map((day) => ({
      date: day.date,
      dayType: typeof day.day["dayType"] === "string" ? (day.day["dayType"] as string) : "",
      cells: columns.map((column) => ({
        columnId: column.id,
        label: columnLabel(column, ctx),
        text: cellText(day, column, columns, ctx),
      })),
    })),
  };
}
