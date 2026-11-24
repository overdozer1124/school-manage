import { describe, expect, it } from "vitest";
import { summarizeRange, type SummaryDayInput, type SummaryValueInput } from "../src/index.js";

// Summary derivation tests (Issue #47; DESIGN schedule 8): the
// counts are derived from day types and daily values on every
// call — school days from the days' types, an item's days from
// the values whose symbol counts, per target as well as overall.

const day = (date: string, dayType: SummaryDayInput["dayType"]): SummaryDayInput => ({
  date,
  dayType,
});

const value = (
  date: string,
  targetId: string | null,
  counts: boolean,
  itemId = "item-lunch",
): SummaryValueInput => ({ date, itemId, targetId, counts });

const GRADES = [1, 2, 3, 4, 5, 6].map((n) => ({
  targetId: `grade:grade-${n}`,
  name: `${n}年`,
}));

const LUNCH = [{ itemId: "item-lunch", name: "給食" }];

describe("summarizeRange day types", () => {
  it("counts school days and every type, in the fixed order, zeros included", () => {
    const result = summarizeRange({
      days: [
        day("2027-10-01", "class_day"),
        day("2027-10-02", "closed_day"),
        day("2027-10-03", "closed_day"),
        day("2027-10-04", "event_day"),
        day("2027-10-05", "class_day"),
      ],
      items: [],
      values: [],
      targets: [],
    });
    expect(result.total.schoolDays).toBe(2);
    expect(result.total.dayTypeCounts).toEqual([
      { dayType: "class_day", count: 2 },
      { dayType: "event_day", count: 1 },
      { dayType: "attendance_day", count: 0 },
      { dayType: "closed_day", count: 2 },
      { dayType: "long_vacation", count: 0 },
    ]);
  });

  it("follows the day types it is given — a changed type changes the count", () => {
    // Nothing is stored: the same dates counted under another
    // type give another answer (the derivation the completion
    // condition asks a test for).
    const dates = ["2027-10-01", "2027-10-02"];
    const before = summarizeRange({
      days: dates.map((d) => day(d, "class_day")),
      items: [],
      values: [],
      targets: [],
    });
    const after = summarizeRange({
      days: [day(dates[0] as string, "class_day"), day(dates[1] as string, "closed_day")],
      items: [],
      values: [],
      targets: [],
    });
    expect(before.total.schoolDays).toBe(2);
    expect(after.total.schoolDays).toBe(1);
  });

  it("buckets by month, in order, and totals the whole range", () => {
    const result = summarizeRange({
      days: [
        day("2027-02-26", "class_day"),
        day("2027-02-27", "closed_day"),
        day("2027-03-01", "class_day"),
        day("2027-03-02", "class_day"),
      ],
      items: LUNCH,
      values: [value("2027-02-26", null, true), value("2027-03-01", null, true)],
      targets: [],
    });
    expect(result.months.map((m) => m.month)).toEqual(["2027-02", "2027-03"]);
    expect(result.months[0]?.schoolDays).toBe(1);
    expect(result.months[0]?.items[0]?.total).toBe(1);
    expect(result.months[1]?.schoolDays).toBe(2);
    expect(result.months[1]?.items[0]?.total).toBe(1);
    expect(result.total.schoolDays).toBe(3);
    expect(result.total.items[0]?.total).toBe(2);
  });

  it("an empty range counts nothing", () => {
    const result = summarizeRange({ days: [], items: LUNCH, values: [], targets: [] });
    expect(result.months).toEqual([]);
    expect(result.total.schoolDays).toBe(0);
    expect(result.total.items).toEqual([
      { itemId: "item-lunch", name: "給食", total: 0, byTarget: [] },
    ]);
  });
});

describe("summarizeRange items", () => {
  it("counts distinct days: am/pm rows and several targets never double a day", () => {
    const result = summarizeRange({
      days: [day("2027-10-01", "class_day"), day("2027-10-02", "class_day")],
      items: LUNCH,
      values: [
        // The same grade, morning and afternoon (two rows, one day).
        value("2027-10-01", "grade:grade-1", true),
        value("2027-10-01", "grade:grade-1", true),
        // A second grade counting the same day.
        value("2027-10-01", "grade:grade-2", true),
        value("2027-10-02", "grade:grade-1", true),
      ],
      targets: GRADES,
    });
    const lunch = result.total.items[0];
    expect(lunch?.total).toBe(2);
    expect(lunch?.byTarget).toEqual([
      { targetId: "grade:grade-1", targetName: "1年", count: 2 },
      { targetId: "grade:grade-2", targetName: "2年", count: 1 },
    ]);
  });

  it("reproduces a per-grade exception: the sixth years count fewer lunch days", () => {
    // Three lunch days for everyone; the sixth years are away
    // on their trip for two of them, recorded as values that do
    // not count (DESIGN schedule 8's example).
    const dates = ["2027-10-01", "2027-10-04", "2027-10-05"];
    const values: SummaryValueInput[] = [];
    for (const date of dates) {
      for (const n of [1, 2, 3, 4, 5]) values.push(value(date, `grade:grade-${n}`, true));
      values.push(value(date, "grade:grade-6", date === "2027-10-01"));
    }
    const result = summarizeRange({
      days: dates.map((d) => day(d, "class_day")),
      items: LUNCH,
      values,
      targets: GRADES,
    });
    const lunch = result.total.items[0];
    expect(lunch?.total).toBe(3);
    expect(lunch?.byTarget).toEqual([
      { targetId: "grade:grade-1", targetName: "1年", count: 3 },
      { targetId: "grade:grade-2", targetName: "2年", count: 3 },
      { targetId: "grade:grade-3", targetName: "3年", count: 3 },
      { targetId: "grade:grade-4", targetName: "4年", count: 3 },
      { targetId: "grade:grade-5", targetName: "5年", count: 3 },
      { targetId: "grade:grade-6", targetName: "6年", count: 1 },
    ]);
  });

  it("an unsplit item counts under 全体， first and alone", () => {
    const result = summarizeRange({
      days: [day("2027-10-01", "class_day"), day("2027-10-02", "class_day")],
      items: LUNCH,
      values: [value("2027-10-01", null, true), value("2027-10-02", null, false)],
      targets: GRADES,
    });
    expect(result.total.items[0]?.total).toBe(1);
    expect(result.total.items[0]?.byTarget).toEqual([
      { targetId: null, targetName: "全体", count: 1 },
    ]);
  });

  it("a target with values that never count stands at zero; an unseen target is absent", () => {
    const result = summarizeRange({
      days: [day("2027-10-01", "class_day")],
      items: LUNCH,
      values: [value("2027-10-01", "grade:grade-6", false)],
      targets: GRADES,
    });
    expect(result.total.items[0]?.total).toBe(0);
    expect(result.total.items[0]?.byTarget).toEqual([
      { targetId: "grade:grade-6", targetName: "6年", count: 0 },
    ]);
  });

  it("ignores values of items that are not counted, and names an unknown target by its id", () => {
    const result = summarizeRange({
      days: [day("2027-10-01", "class_day")],
      items: LUNCH,
      values: [
        value("2027-10-01", null, true, "item-other"),
        value("2027-10-01", "grade:grade-9", true),
      ],
      targets: GRADES,
    });
    expect(result.total.items[0]?.total).toBe(1);
    expect(result.total.items[0]?.byTarget).toEqual([
      { targetId: "grade:grade-9", targetName: "grade:grade-9", count: 1 },
    ]);
  });
});
