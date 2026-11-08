import { describe, expect, it } from "vitest";
import {
  absencePublicSchema,
  absenceSchema,
  calendarDaySchema,
  calendarEventSchema,
  calendarTimeSchema,
  calendarTimeToPeriods,
  changeEventSchema,
  dateStringSchema,
  dayPatternSchema,
  effectiveWeekday,
  timeStringSchema,
  type PeriodTime,
} from "../src/index.js";

const meta = {
  schoolId: "school-1",
  id: "entity-1",
  revision: 1,
  updatedBy: "person-1",
  updatedVia: "platform",
} as const;

describe("date and time strings", () => {
  it("accepts real dates and rejects impossible ones", () => {
    expect(dateStringSchema.safeParse("2028-02-29").success).toBe(true);
    expect(dateStringSchema.safeParse("2026-02-30").success).toBe(false);
    expect(dateStringSchema.safeParse("2025-02-29").success).toBe(false);
    expect(dateStringSchema.safeParse("2026-2-3").success).toBe(false);
  });

  it("rejects 25:00 and other out-of-range times", () => {
    expect(timeStringSchema.safeParse("23:59").success).toBe(true);
    expect(timeStringSchema.safeParse("25:00").success).toBe(false);
    expect(timeStringSchema.safeParse("12:60").success).toBe(false);
  });
});

describe("fixed codes", () => {
  it("rejects unknown codes", () => {
    const day = calendarDaySchema.safeParse({
      ...meta,
      date: "2026-11-09",
      dayType: "unknown_code",
      dayScheduleId: null,
      weekdaySwap: null,
    });
    expect(day.success).toBe(false);
  });

  it("accepts a day with a weekday swap", () => {
    const day = calendarDaySchema.parse({
      ...meta,
      date: "2026-11-09",
      dayType: "class_day",
      dayScheduleId: null,
      weekdaySwap: "wed",
    });
    expect(day.weekdaySwap).toBe("wed");
  });
});

describe("calendarTime validation", () => {
  it("rejects a period range with to < from", () => {
    expect(calendarTimeSchema.safeParse({ kind: "periods", from: 3, to: 2 }).success).toBe(false);
    expect(calendarTimeSchema.safeParse({ kind: "periods", from: 2, to: 3 }).success).toBe(true);
  });

  it("rejects an event whose endDate is before its date", () => {
    const event = calendarEventSchema.safeParse({
      ...meta,
      title: "音楽祭",
      kind: "event",
      date: "2026-11-10",
      endDate: "2026-11-09",
      time: { kind: "all_day" },
      location: null,
      assigneeIds: [],
      visibility: "public",
      certainty: "confirmed",
      impacts: [],
    });
    expect(event.success).toBe(false);
  });

  it("rejects an absence whose toDate is before its fromDate", () => {
    const absence = absenceSchema.safeParse({
      ...meta,
      staffId: "staff-1",
      fromDate: "2026-11-10",
      toDate: "2026-11-09",
      time: { kind: "all_day" },
      kind: "leave",
      subdivisionKey: "annual",
      certainty: "confirmed",
    });
    expect(absence.success).toBe(false);
  });
});

const normalDay: PeriodTime[] = [
  { period: 1, startsAt: "08:50", endsAt: "09:40" },
  { period: 2, startsAt: "09:50", endsAt: "10:40" },
  { period: 3, startsAt: "10:50", endsAt: "11:40" },
  { period: 4, startsAt: "11:50", endsAt: "12:40" },
  { period: 5, startsAt: "13:30", endsAt: "14:20" },
  { period: 6, startsAt: "14:30", endsAt: "15:20" },
];

const shortenedDay: PeriodTime[] = [
  { period: 1, startsAt: "08:50", endsAt: "09:30" },
  { period: 2, startsAt: "09:40", endsAt: "10:20" },
  { period: 3, startsAt: "10:30", endsAt: "11:10" },
  { period: 4, startsAt: "11:20", endsAt: "12:00" },
  { period: 5, startsAt: "12:50", endsAt: "13:30" },
  { period: 6, startsAt: "13:40", endsAt: "14:20" },
];

describe("calendarTimeToPeriods", () => {
  it("maps the same clock time to different periods under normal and shortened patterns", () => {
    const time = { kind: "clock", startsAt: "11:00", endsAt: "11:30" } as const;
    expect(calendarTimeToPeriods(time, normalDay)).toEqual([3]);
    expect(calendarTimeToPeriods(time, shortenedDay)).toEqual([3, 4]);
  });

  it("covers periods that a noon-crossing clock time overlaps", () => {
    const time = { kind: "clock", startsAt: "11:30", endsAt: "13:00" } as const;
    expect(calendarTimeToPeriods(time, normalDay)).toEqual([3, 4]);
    // Period 4 itself spans noon (11:50-12:40).
    expect(
      calendarTimeToPeriods({ kind: "clock", startsAt: "12:00", endsAt: "13:00" }, normalDay),
    ).toEqual([4]);
  });

  it("handles all_day, half_day, a point in time and period ranges", () => {
    expect(calendarTimeToPeriods({ kind: "all_day" }, normalDay)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calendarTimeToPeriods({ kind: "half_day", half: "am" }, normalDay)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(calendarTimeToPeriods({ kind: "half_day", half: "pm" }, normalDay)).toEqual([4, 5, 6]);
    expect(
      calendarTimeToPeriods({ kind: "clock", startsAt: "10:00", endsAt: null }, normalDay),
    ).toEqual([2]);
    expect(calendarTimeToPeriods({ kind: "periods", from: 2, to: 9 }, normalDay)).toEqual([
      2, 3, 4, 5, 6,
    ]);
  });
});

describe("effectiveWeekday", () => {
  it("uses the date's own weekday, or the swap when set", () => {
    // 2026-11-09 is a Monday (the design doc's example date).
    expect(effectiveWeekday("2026-11-09", null)).toBe("mon");
    expect(effectiveWeekday("2026-11-09", "wed")).toBe("wed");
  });
});

describe("absence privacy shape", () => {
  it("drops the leave subdivision when parsed for the timetable", () => {
    const parsed = absencePublicSchema.parse({
      ...meta,
      staffId: "staff-1",
      fromDate: "2026-11-10",
      toDate: "2026-11-10",
      time: { kind: "all_day" },
      kind: "leave",
      subdivisionKey: "annual",
      certainty: "confirmed",
    });
    expect("subdivisionKey" in parsed).toBe(false);
    expect(parsed.kind).toBe("leave");
  });
});

describe("dayPattern and changeEvent", () => {
  it("rejects duplicate period numbers in a day pattern", () => {
    const pattern = dayPatternSchema.safeParse({
      schoolId: "school-1",
      id: "pattern-1",
      name: "通常日課",
      kind: "normal",
      periods: [
        { period: 1, startsAt: "08:50", endsAt: "09:40" },
        { period: 1, startsAt: "09:50", endsAt: "10:40" },
      ],
    });
    expect(pattern.success).toBe(false);
  });

  it("parses a change event and rejects an unknown op", () => {
    const event = {
      seq: 42,
      schoolId: "school-1",
      kind: "event",
      entityId: "entity-1",
      revision: 2,
      op: "upsert",
      occurredAt: "2026-11-08T01:00:00.000Z",
      actor: { userId: "person-1", via: "schedule" },
    } as const;
    expect(changeEventSchema.parse(event).seq).toBe(42);
    expect(changeEventSchema.safeParse({ ...event, op: "update" }).success).toBe(false);
  });
});
