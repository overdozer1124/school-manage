import type { PublicationSnapshot } from "../db/schema.js";

/**
 * The diff between two publications' snapshots (Issue #48):
 * what changed from the previous version — the days that
 * changed, and in each of them the day type and the columns
 * whose printed text differs. Days and columns that read the
 * same in both versions are not listed at all: the answer to
 * "what did the new version change?" is the changed days only
 * (the Issue's completion condition). Pure: the snapshots are
 * plain stored JSON, so the comparison needs no database and
 * no platform.
 */

/** One column's text change on one day. A column present on
 *  only one side reads as an empty text on the other. */
export interface PublicationCellChange {
  columnId: string;
  label: string;
  before: string;
  after: string;
}

/** One changed day: its day-type change, when the type moved,
 *  and its changed cells, in the later version's column order
 *  (columns only the earlier version had come last). */
export interface PublicationDayChange {
  date: string;
  dayType?: { before: string; after: string };
  cells: PublicationCellChange[];
}

export function diffSnapshots(
  before: PublicationSnapshot,
  after: PublicationSnapshot,
): PublicationDayChange[] {
  const beforeDays = new Map(before.days.map((day) => [day.date, day]));
  const afterDays = new Map(after.days.map((day) => [day.date, day]));
  const dates = [...new Set([...beforeDays.keys(), ...afterDays.keys()])].sort();
  const changes: PublicationDayChange[] = [];
  for (const date of dates) {
    const beforeDay = beforeDays.get(date);
    const afterDay = afterDays.get(date);
    const dayChange: PublicationDayChange = { date, cells: [] };
    const beforeType = beforeDay?.dayType ?? "";
    const afterType = afterDay?.dayType ?? "";
    if (beforeType !== afterType) {
      dayChange.dayType = { before: beforeType, after: afterType };
    }
    const beforeCells = new Map((beforeDay?.cells ?? []).map((cell) => [cell.columnId, cell]));
    const afterCells = new Map((afterDay?.cells ?? []).map((cell) => [cell.columnId, cell]));
    const columnIds: string[] = [];
    for (const cell of afterDay?.cells ?? []) {
      if (!columnIds.includes(cell.columnId)) columnIds.push(cell.columnId);
    }
    for (const cell of beforeDay?.cells ?? []) {
      if (!columnIds.includes(cell.columnId)) columnIds.push(cell.columnId);
    }
    for (const columnId of columnIds) {
      const beforeCell = beforeCells.get(columnId);
      const afterCell = afterCells.get(columnId);
      const beforeText = beforeCell?.text ?? "";
      const afterText = afterCell?.text ?? "";
      if (beforeText !== afterText) {
        dayChange.cells.push({
          columnId,
          label: afterCell?.label ?? beforeCell?.label ?? "",
          before: beforeText,
          after: afterText,
        });
      }
    }
    if (dayChange.dayType !== undefined || dayChange.cells.length > 0) {
      changes.push(dayChange);
    }
  }
  return changes;
}
