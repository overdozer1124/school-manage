import { describe, expect, it } from "vitest";
import { DEV_BOOTSTRAP, createDevApi } from "../src/devAdapter";
import {
  dailyCellText,
  dayMark,
  monthEndOf,
  rangeFor,
  stepAnchor,
  undecidedForMonth,
  weekSpanOf,
} from "../src/lib";
import type { RangeDayData, ViewDefinitionData } from "../src/types";

// Pure rendering helpers (Issue #34): the date order of the periods,
// the day marks, the same-value grouping through Issue #32's pure
// function, and the undecided section's month filter.
const monthView = DEV_BOOTSTRAP.views[0] as ViewDefinitionData;
const weekView = DEV_BOOTSTRAP.views[1] as ViewDefinitionData;

describe("period ranges", () => {
  it("a month view spans the whole month, in ascending date order", () => {
    expect(rangeFor(monthView, "2026-11-15")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(monthEndOf("2027-02-10")).toBe("2027-02-28");
    expect(monthEndOf("2028-02-10")).toBe("2028-02-29");
  });

  it("a two-week view starts on Monday and spans 14 days", () => {
    // 2026-11-15 is a Sunday; its week starts Monday 2026-11-09.
    expect(weekSpanOf(weekView)).toBe(14);
    expect(rangeFor(weekView, "2026-11-15")).toEqual({ from: "2026-11-09", to: "2026-11-22" });
  });

  it("stepping moves by one month or by the week's span", () => {
    expect(stepAnchor(monthView, "2026-11-01", 1)).toBe("2026-12-01");
    expect(stepAnchor(monthView, "2026-11-01", -1)).toBe("2026-10-01");
    expect(stepAnchor(weekView, "2026-11-09", 1)).toBe("2026-11-23");
    expect(stepAnchor(weekView, "2026-11-09", -1)).toBe("2026-10-26");
  });
});

function day(partial: Partial<RangeDayData> & { date: string }): RangeDayData {
  return {
    day: {
      date: partial.date,
      dayType: "class_day",
      dayTypeLabel: null,
      dayScheduleId: null,
      weekdaySwap: null,
      note: null,
      source: "default",
    },
    holidays: [],
    events: [],
    absences: [],
    dailyValues: [],
    dutyAssignments: [],
    ...partial,
  };
}

describe("day marks (colour plus text, DESIGN 9.1)", () => {
  it("a Saturday is marked sat, a Sunday holiday-kind, a weekday plain", () => {
    expect(dayMark(day({ date: "2026-11-14" }), []).kind).toBe("sat"); // Saturday
    expect(dayMark(day({ date: "2026-11-15" }), []).kind).toBe("holiday"); // Sunday
    expect(dayMark(day({ date: "2026-11-16" }), []).kind).toBe(""); // Monday
  });

  it("a weekday holiday is marked by name as well as by kind", () => {
    const mark = dayMark(
      day({
        date: "2026-11-03", // Tuesday, 文化の日
        holidays: [{ id: "h1", date: "2026-11-03", name: "文化の日", kind: "national_holiday" }],
        day: {
          date: "2026-11-03",
          dayType: "closed_day",
          dayTypeLabel: null,
          dayScheduleId: null,
          weekdaySwap: null,
          note: null,
          source: "default",
        },
      }),
      [],
    );
    expect(mark.kind).toBe("holiday");
    expect(mark.sub).toContain("文化の日");
    expect(mark.closed).toBe(true);
  });

  it("a recorded day type and pattern code appear in the sub-line", () => {
    const mark = dayMark(
      day({
        date: "2026-11-16",
        day: {
          date: "2026-11-16",
          dayType: "event_day",
          dayTypeLabel: null,
          dayScheduleId: "pattern-a",
          weekdaySwap: null,
          note: null,
          source: "recorded",
        },
      }),
      [{ id: "pattern-a", code: "A", name: "A日課" }],
    );
    expect(mark.sub).toContain("行事日");
    expect(mark.sub).toContain("A日課");
  });
});

describe("same-value grouping in a cell (Issue #32's pure function)", () => {
  it("groups consecutive grades sharing a dismissal time, and splits the rest", async () => {
    const api = createDevApi();
    const range = await api.getRange({
      from: "2026-11-02",
      to: "2026-11-02",
      viewId: "view-month-staff",
    });
    const monday = range.days[0] as RangeDayData; // 2026-11-02 is a Monday (split day)
    const dismissal = DEV_BOOTSTRAP.views[0]?.columns.find(
      (c) => c.itemDefinitionId === "item-dismissal",
    );
    expect(dismissal).toBeDefined();
    expect(dailyCellText(monday, dismissal as NonNullable<typeof dismissal>, DEV_BOOTSTRAP)).toBe(
      "1～3年 14:30／4～6年 15:20",
    );
  });

  it("shows one range when every grade shares the value", async () => {
    const api = createDevApi();
    const range = await api.getRange({
      from: "2026-11-03",
      to: "2026-11-05",
      viewId: "view-month-staff",
    });
    const thursday = range.days[2] as RangeDayData; // 2026-11-05, a Thursday (single time)
    const dismissal = DEV_BOOTSTRAP.views[0]?.columns.find(
      (c) => c.itemDefinitionId === "item-dismissal",
    );
    expect(dailyCellText(thursday, dismissal as NonNullable<typeof dismissal>, DEV_BOOTSTRAP)).toBe(
      "1～6年 14:30",
    );
  });

  it("does not group when the column switches grouping off", async () => {
    const api = createDevApi();
    const range = await api.getRange({
      from: "2026-11-02",
      to: "2026-11-02",
      viewId: "view-month-staff",
    });
    const monday = range.days[0] as RangeDayData;
    const dismissal = DEV_BOOTSTRAP.views[0]?.columns.find(
      (c) => c.itemDefinitionId === "item-dismissal",
    );
    const off = { ...(dismissal as NonNullable<typeof dismissal>), groupSameValues: false };
    expect(dailyCellText(monday, off, DEV_BOOTSTRAP)).toBe(
      "1年 14:30／2年 14:30／3年 14:30／4年 15:20／5年 15:20／6年 15:20",
    );
  });
});

describe("undecided section", () => {
  it("shows the anchor month's group and the fully undecided group, not other months'", async () => {
    const api = createDevApi();
    const range = await api.getRange({
      from: "2026-11-01",
      to: "2026-11-30",
      viewId: "view-month-staff",
    });
    const titles = undecidedForMonth(range, "2026-11-15").map((e) => e["title"]);
    expect(titles).toEqual(["作品展", "研究発表会"]);
    // December shows only the fully undecided group.
    const december = undecidedForMonth(range, "2026-12-01").map((e) => e["title"]);
    expect(december).toEqual(["研究発表会"]);
  });
});
