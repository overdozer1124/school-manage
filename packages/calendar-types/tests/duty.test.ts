import { describe, expect, it } from "vitest";
import {
  addDays,
  datesInRange,
  defaultDayType,
  dutyAppliesOn,
  eventSlot,
  isDutySlot,
  isInTerm,
  nextRotationIndex,
  planRotation,
  resolveDayFacts,
  slotsForGranularity,
  slotsOverlap,
  weekStartOf,
  type DutyDayFacts,
} from "../src/index.js";

// Duty logic tests (Issue #30). The slot / applicable-period /
// rotation cases are carried over from the prototype
// (school-schedule server/src/logic.test.ts) and adapted: person
// ids are staff-master id strings, and long_vacation_only / term
// read the platform calendar's facts instead of configured dates.

describe("slotsOverlap / eventSlot (prototype)", () => {
  const ev = (o: Partial<Parameters<typeof eventSlot>[0]>) => ({
    isAllDay: false,
    slot: "all_day",
    startsAt: null,
    endsAt: null,
    ...o,
  });
  it("explicit am/pm wins", () => {
    expect(eventSlot(ev({ isAllDay: true, slot: "am" }))).toBe("am");
    expect(eventSlot(ev({ slot: "pm", startsAt: "09:00", endsAt: "10:00" }))).toBe("pm");
  });
  it("all-day event occupies the whole day", () => {
    expect(eventSlot(ev({ isAllDay: true }))).toBe("all_day");
  });
  it("timed events are placed by their hours", () => {
    expect(eventSlot(ev({ startsAt: "09:00", endsAt: "11:30" }))).toBe("am");
    expect(eventSlot(ev({ startsAt: "09:00", endsAt: "12:00" }))).toBe("am");
    expect(eventSlot(ev({ startsAt: "13:00", endsAt: "16:00" }))).toBe("pm");
    expect(eventSlot(ev({ startsAt: "10:00", endsAt: "15:00" }))).toBe("all_day");
    expect(eventSlot(ev({}))).toBe("all_day");
  });
  it("a morning-only trip does not clash with an afternoon duty (DESIGN 4.7.2)", () => {
    const trip = eventSlot(ev({ startsAt: "08:30", endsAt: "11:00" }));
    expect(slotsOverlap("pm", trip)).toBe(false);
    expect(slotsOverlap("am", trip)).toBe(true);
    expect(slotsOverlap("all_day", trip)).toBe(true);
  });
});

describe("slots per granularity", () => {
  it("fixed slots per granularity, period slots are numbers", () => {
    expect(slotsForGranularity("day")).toEqual(["all_day"]);
    expect(slotsForGranularity("am_pm")).toEqual(["am", "pm"]);
    expect(slotsForGranularity("week")).toEqual(["week"]);
    expect(slotsForGranularity("period")).toEqual([]);
    expect(isDutySlot("day", "all_day")).toBe(true);
    expect(isDutySlot("day", "am")).toBe(false);
    expect(isDutySlot("am_pm", "pm")).toBe(true);
    expect(isDutySlot("week", "week")).toBe(true);
    expect(isDutySlot("period", "3")).toBe(true);
    expect(isDutySlot("period", "am")).toBe(false);
  });
});

describe("day facts from the platform calendar", () => {
  const terms = [
    { startsOn: "2026-04-01", endsOn: "2026-07-20" },
    { startsOn: "2026-09-01", endsOn: "2026-12-25" },
  ];
  it("unrecorded dates derive from the weekday (Issue #23 convention)", () => {
    expect(defaultDayType("2026-04-06")).toBe("class_day"); // Monday
    expect(defaultDayType("2026-04-04")).toBe("closed_day"); // Saturday
    expect(defaultDayType("2026-04-05")).toBe("closed_day"); // Sunday
  });
  it("a recorded day type wins over the derivation", () => {
    expect(resolveDayFacts("2026-04-04", "event_day", terms).dayType).toBe("event_day");
    expect(resolveDayFacts("2026-08-01", "long_vacation", terms)).toEqual({
      dayType: "long_vacation",
      inTerm: false,
    });
  });
  it("inTerm follows the term ranges, boundaries included", () => {
    expect(isInTerm("2026-04-01", terms)).toBe(true);
    expect(isInTerm("2026-07-20", terms)).toBe(true);
    expect(isInTerm("2026-07-21", terms)).toBe(false);
    expect(isInTerm("2026-09-01", terms)).toBe(true);
    expect(isInTerm("2026-08-15", terms)).toBe(false);
  });
});

describe("dutyAppliesOn", () => {
  const facts = (dayType: DutyDayFacts["dayType"], inTerm: boolean): DutyDayFacts => ({
    dayType,
    inTerm,
  });
  it("all_year always applies", () => {
    expect(
      dutyAppliesOn(
        { applicablePeriod: "all_year", startsOn: null, endsOn: null },
        "2026-08-01",
        facts("long_vacation", false),
      ),
    ).toBe(true);
  });
  it("custom_range applies only inside its dates (prototype)", () => {
    const def = {
      applicablePeriod: "custom_range" as const,
      startsOn: "2026-07-21",
      endsOn: "2026-08-31",
    };
    expect(dutyAppliesOn(def, "2026-07-20", facts("class_day", true))).toBe(false);
    expect(dutyAppliesOn(def, "2026-07-21", facts("class_day", true))).toBe(true);
    expect(dutyAppliesOn(def, "2026-08-31", facts("class_day", true))).toBe(true);
    expect(dutyAppliesOn(def, "2026-09-01", facts("class_day", true))).toBe(false);
  });
  it("custom_range without dates applies nowhere (prototype)", () => {
    expect(
      dutyAppliesOn(
        { applicablePeriod: "custom_range", startsOn: null, endsOn: null },
        "2026-05-01",
        facts("class_day", true),
      ),
    ).toBe(false);
  });
  it("long_vacation_only follows the day type, not configured dates", () => {
    const def = { applicablePeriod: "long_vacation_only" as const, startsOn: null, endsOn: null };
    expect(dutyAppliesOn(def, "2026-08-01", facts("long_vacation", false))).toBe(true);
    expect(dutyAppliesOn(def, "2026-08-01", facts("closed_day", false))).toBe(false);
    expect(dutyAppliesOn(def, "2026-05-01", facts("class_day", true))).toBe(false);
  });
  it("term follows the school's terms", () => {
    const def = { applicablePeriod: "term" as const, startsOn: null, endsOn: null };
    expect(dutyAppliesOn(def, "2026-05-01", facts("class_day", true))).toBe(true);
    expect(dutyAppliesOn(def, "2026-08-01", facts("long_vacation", false))).toBe(false);
  });
});

describe("nextRotationIndex (prototype, string ids)", () => {
  const members = ["teacher-1", "teacher-2", "teacher-3"];
  it("starts at 0 with no history", () => {
    expect(nextRotationIndex(members, null)).toBe(0);
    expect(nextRotationIndex([], "teacher-1")).toBe(0);
  });
  it("continues after the last holder and wraps", () => {
    expect(nextRotationIndex(members, "teacher-1")).toBe(1);
    expect(nextRotationIndex(members, "teacher-2")).toBe(2);
    expect(nextRotationIndex(members, "teacher-3")).toBe(0);
  });
  it("unknown last holder restarts at 0", () => {
    expect(nextRotationIndex(members, "teacher-99")).toBe(0);
  });
});

describe("planRotation", () => {
  const members = ["teacher-1", "teacher-2", "teacher-3"];
  it("advances per cell, so am and pm differ (scenario 4)", () => {
    const cells = [
      { date: "2026-07-21", slot: "am" },
      { date: "2026-07-21", slot: "pm" },
      { date: "2026-07-22", slot: "am" },
      { date: "2026-07-22", slot: "pm" },
    ];
    expect(planRotation(members, 0, cells).map((p) => p.personId)).toEqual([
      "teacher-1",
      "teacher-2",
      "teacher-3",
      "teacher-1",
    ]);
  });
  it("honours the start index and wraps", () => {
    const cells = [
      { date: "2026-04-06", slot: "all_day" },
      { date: "2026-04-07", slot: "all_day" },
    ];
    expect(planRotation(members, 2, cells).map((p) => p.personId)).toEqual([
      "teacher-3",
      "teacher-1",
    ]);
  });
  it("with change weekdays the holder changes only on those days", () => {
    // 2026-04-06 is a Monday; changeover on Wednesdays.
    const cells = ["2026-04-06", "2026-04-07", "2026-04-08", "2026-04-09"].map((date) => ({
      date,
      slot: "all_day",
    }));
    expect(planRotation(members, 0, cells, ["wed"]).map((p) => p.personId)).toEqual([
      "teacher-1",
      "teacher-1",
      "teacher-2",
      "teacher-2",
    ]);
  });
  it("empty members or cells plan nothing", () => {
    expect(planRotation([], 0, [{ date: "2026-04-06", slot: "all_day" }])).toEqual([]);
    expect(planRotation(members, 0, [])).toEqual([]);
  });
});

describe("date helpers", () => {
  it("addDays crosses months and years", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("datesInRange is inclusive and empty when reversed", () => {
    expect(datesInRange("2026-04-01", "2026-04-03")).toEqual([
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
    ]);
    expect(datesInRange("2026-04-03", "2026-04-01")).toEqual([]);
  });
  it("weekStartOf defaults to Monday and honours a Friday changeover", () => {
    expect(weekStartOf("2026-04-08")).toBe("2026-04-06"); // Wed -> Mon
    expect(weekStartOf("2026-04-06")).toBe("2026-04-06");
    expect(weekStartOf("2026-04-05")).toBe("2026-03-30"); // Sun -> previous Mon
    expect(weekStartOf("2026-04-08", "fri")).toBe("2026-04-03");
    expect(weekStartOf("2026-04-03", "fri")).toBe("2026-04-03");
  });
});
