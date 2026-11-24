import { describe, expect, it } from "vitest";
import type { PublicationSnapshot } from "../src/db/schema.js";
import { diffSnapshots } from "../src/publications/diff.js";

// The version diff (Issue #48): two publications' structured
// snapshots compared day by day. Only the days that changed
// are listed — the completion condition the Issue names — with
// the day type and the changed cells of each.

type Day = PublicationSnapshot["days"][number];

function day(date: string, dayType: string, cells: Day["cells"]): Day {
  return { date, dayType, cells };
}

function snapshot(days: Day[]): PublicationSnapshot {
  return { version: 1, days };
}

const cell = (columnId: string, label: string, text: string) => ({ columnId, label, text });

describe("diffSnapshots (Issue #48)", () => {
  it("identical snapshots have no changed days", () => {
    const snap = snapshot([
      day("2027-11-01", "class_day", [cell("col-lunch", "給食", "○")]),
      day("2027-11-02", "class_day", [cell("col-lunch", "給食", "")]),
    ]);
    expect(diffSnapshots(snap, structuredClone(snap))).toEqual([]);
  });

  it("only the changed day is listed, with the cell's before and after", () => {
    const before = snapshot([
      day("2027-11-01", "class_day", [cell("col-lunch", "給食", "○")]),
      day("2027-11-02", "class_day", [cell("col-lunch", "給食", "○")]),
      day("2027-11-03", "closed_day", [cell("col-lunch", "給食", "")]),
    ]);
    const after = snapshot([
      day("2027-11-01", "class_day", [cell("col-lunch", "給食", "○")]),
      day("2027-11-02", "class_day", [cell("col-lunch", "給食", "×")]),
      day("2027-11-03", "closed_day", [cell("col-lunch", "給食", "")]),
    ]);
    expect(diffSnapshots(before, after)).toEqual([
      {
        date: "2027-11-02",
        cells: [{ columnId: "col-lunch", label: "給食", before: "○", after: "×" }],
      },
    ]);
  });

  it("a day-type-only change lists the day with no cell changes", () => {
    const before = snapshot([day("2027-11-15", "class_day", [cell("col-lunch", "給食", "")])]);
    const after = snapshot([day("2027-11-15", "event_day", [cell("col-lunch", "給食", "")])]);
    expect(diffSnapshots(before, after)).toEqual([
      {
        date: "2027-11-15",
        dayType: { before: "class_day", after: "event_day" },
        cells: [],
      },
    ]);
  });

  it("a column only on one side reads as an empty text on the other", () => {
    const before = snapshot([
      day("2027-11-01", "class_day", [
        cell("col-lunch", "給食", "○"),
        cell("col-note", "メモ", "廊下の掲示"),
      ]),
    ]);
    const after = snapshot([
      day("2027-11-01", "class_day", [
        cell("col-lunch", "給食", "○"),
        cell("col-bus", "バス", "15:30"),
      ]),
    ]);
    // The later version's column order leads; the removed
    // column follows it.
    expect(diffSnapshots(before, after)).toEqual([
      {
        date: "2027-11-01",
        cells: [
          { columnId: "col-bus", label: "バス", before: "", after: "15:30" },
          { columnId: "col-note", label: "メモ", before: "廊下の掲示", after: "" },
        ],
      },
    ]);
  });

  it("a day only on one side lists its non-empty cells and its type", () => {
    const before = snapshot([day("2027-11-01", "class_day", [cell("col-lunch", "給食", "○")])]);
    const after = snapshot([
      day("2027-11-01", "class_day", [cell("col-lunch", "給食", "○")]),
      day("2027-11-02", "event_day", [
        cell("col-lunch", "給食", ""),
        cell("col-events", "行事", "運動会"),
      ]),
    ]);
    expect(diffSnapshots(before, after)).toEqual([
      {
        date: "2027-11-02",
        dayType: { before: "", after: "event_day" },
        cells: [{ columnId: "col-events", label: "行事", before: "", after: "運動会" }],
      },
    ]);
  });
});
