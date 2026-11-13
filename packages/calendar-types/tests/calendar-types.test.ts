import { describe, expect, it } from "vitest";
import {
  absencePublicSchema,
  absenceSchema,
  absenceSubdivisionSchema,
  canViewAbsenceSubdivision,
  defaultLeaveSubdivisions,
  isOwnAbsence,
  calendarDayInputSchema,
  calendarDaySchema,
  calendarEventSchema,
  calendarTimeSchema,
  calendarTimeToPeriods,
  changeEntityKindSchema,
  changeEventSchema,
  dateStringSchema,
  dayPatternSchema,
  derivedImpactSchema,
  staffMemberRecordSchema,
  staffMemberSchema,
  effectiveWeekday,
  holidayInputSchema,
  holidaySchema,
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
      dayTypeLabel: null,
      dayScheduleId: null,
      weekdaySwap: null,
      note: null,
    });
    expect(day.success).toBe(false);
  });

  it("accepts a day with a weekday swap", () => {
    const day = calendarDaySchema.parse({
      ...meta,
      date: "2026-11-09",
      dayType: "class_day",
      dayTypeLabel: null,
      dayScheduleId: null,
      weekdaySwap: "wed",
      note: "月曜時間割で実施",
    });
    expect(day.weekdaySwap).toBe("wed");
  });

  it("accepts a day input and rejects an empty school wording", () => {
    const input = calendarDayInputSchema.parse({
      schoolId: "school-1",
      id: "day-1",
      date: "2026-11-09",
      dayType: "event_day",
      dayTypeLabel: "文化祭",
      dayScheduleId: "sched-special",
      weekdaySwap: null,
      note: null,
    });
    expect(input.dayTypeLabel).toBe("文化祭");
    expect(calendarDayInputSchema.safeParse({ ...input, dayTypeLabel: "" }).success).toBe(false);
  });

  it("accepts the four holiday kinds and rejects unknown ones", () => {
    for (const kind of [
      "national_holiday",
      "substitute_holiday",
      "school_closed_day",
      "office_closed_day",
    ]) {
      const holiday = holidaySchema.parse({
        ...meta,
        date: "2026-11-03",
        name: "文化の日",
        kind,
      });
      expect(holiday.kind).toBe(kind);
    }
    expect(
      holidaySchema.safeParse({
        ...meta,
        date: "2026-11-03",
        name: "文化の日",
        kind: "unknown_kind",
      }).success,
    ).toBe(false);
    expect(
      holidayInputSchema.safeParse({
        schoolId: "school-1",
        id: "holiday-1",
        date: "2026-11-03",
        name: "",
        kind: "national_holiday",
      }).success,
    ).toBe(false);
  });

  it("treats holiday as a change entity kind", () => {
    expect(changeEntityKindSchema.safeParse("holiday").success).toBe(true);
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
      purpose: null,
      note: null,
      createdBy: "person-1",
      confirmedBy: "person-2",
      confirmedAt: "2026-11-01T09:00:00.000Z",
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

  it("yields no period for a point in time falling in a break", () => {
    // 09:45 is the break between period 1 (ends 09:40) and period 2
    // (starts 09:50): with endsAt null, no period contains the moment,
    // so the result is an empty array.
    expect(
      calendarTimeToPeriods({ kind: "clock", startsAt: "09:45", endsAt: null }, normalDay),
    ).toEqual([]);
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
  const absence = {
    ...meta,
    staffId: "staff-1",
    fromDate: "2026-11-10",
    toDate: "2026-11-10",
    time: { kind: "all_day" },
    kind: "leave",
    subdivisionKey: "annual",
    certainty: "confirmed",
    purpose: null,
    note: null,
    createdBy: "person-1",
    confirmedBy: "person-2",
    confirmedAt: "2026-11-01T09:00:00.000Z",
  } as const;

  it("drops the leave subdivision when parsed for the timetable", () => {
    const parsed = absencePublicSchema.parse(absence);
    expect("subdivisionKey" in parsed).toBe(false);
    expect(parsed.kind).toBe("leave");
  });

  it("judges an absence as one's own by the membership's teacher_id", () => {
    expect(isOwnAbsence(absence, "staff-1")).toBe(true);
    expect(isOwnAbsence(absence, "staff-2")).toBe(false);
    expect(isOwnAbsence(absence, null)).toBe(false);
    expect(isOwnAbsence(absence, undefined)).toBe(false);
  });

  it("shows the subdivision to an Admin and to the person themselves only", () => {
    expect(canViewAbsenceSubdivision(absence, { teacherId: "staff-2", isAdmin: true })).toBe(true);
    expect(canViewAbsenceSubdivision(absence, { teacherId: "staff-1", isAdmin: false })).toBe(true);
    expect(canViewAbsenceSubdivision(absence, { teacherId: "staff-2", isAdmin: false })).toBe(
      false,
    );
    expect(canViewAbsenceSubdivision(absence, { teacherId: null, isAdmin: false })).toBe(false);
  });
});

describe("default leave subdivisions", () => {
  it("carries the eight initial items of schedule DESIGN 6.5, all under leave", () => {
    expect(defaultLeaveSubdivisions).toHaveLength(8);
    expect(defaultLeaveSubdivisions.map((s) => s.label)).toEqual([
      "年休",
      "病休",
      "特休",
      "夏特",
      "看護",
      "職専免",
      "振休",
      "その他",
    ]);
    for (const s of defaultLeaveSubdivisions) {
      expect(s.code).toBe("leave");
      expect(absenceSubdivisionSchema.safeParse(s).success).toBe(true);
    }
    expect(new Set(defaultLeaveSubdivisions.map((s) => s.key)).size).toBe(8);
  });
});

describe("masters", () => {
  const staff = {
    schoolId: "school-1",
    id: "staff-1",
    name: "山田太郎",
    shortName: "山田",
    sortOrder: 1,
    active: true,
    personId: null,
  };

  it("requires the active flag on a staff member", () => {
    expect(staffMemberSchema.safeParse(staff).success).toBe(true);
    expect(staffMemberSchema.safeParse({ ...staff, active: undefined }).success).toBe(false);
  });

  it("parses a staff record with the entity meta, and rejects revision 0", () => {
    const record = { ...staff, revision: 3, updatedBy: "person-1", updatedVia: "platform" };
    expect(staffMemberRecordSchema.safeParse(record).success).toBe(true);
    expect(staffMemberRecordSchema.safeParse({ ...record, revision: 0 }).success).toBe(false);
  });
});

describe("dayPattern and changeEvent", () => {
  it("rejects duplicate period numbers in a day pattern", () => {
    const pattern = dayPatternSchema.safeParse({
      schoolId: "school-1",
      id: "pattern-1",
      code: "A",
      name: "通常日課",
      kind: "normal",
      periods: [
        { period: 1, label: "1限", startsAt: "08:50", endsAt: "09:40" },
        { period: 1, label: "1限", startsAt: "09:50", endsAt: "10:40" },
      ],
    });
    expect(pattern.success).toBe(false);
  });

  it("accepts the out-of-range bands (0 = morning, 99 = after school) with labels", () => {
    const pattern = dayPatternSchema.safeParse({
      schoolId: "school-1",
      id: "pattern-1",
      code: "A",
      name: "通常日課",
      kind: "normal",
      periods: [
        { period: 0, label: "朝", startsAt: "08:00", endsAt: "08:40" },
        { period: 1, label: "1限", startsAt: "08:50", endsAt: "09:40" },
        { period: 99, label: "放課後", startsAt: "15:40", endsAt: "16:30" },
      ],
    });
    expect(pattern.success).toBe(true);
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

describe("derivedImpact", () => {
  const impact = {
    date: "2026-11-09",
    periods: [2, 3],
    targets: [{ axis: "grade", id: "grade-1" }],
  } as const;

  it("accepts a real date", () => {
    expect(derivedImpactSchema.parse(impact).date).toBe("2026-11-09");
  });

  it("rejects a date string that is not a real date", () => {
    expect(derivedImpactSchema.safeParse({ ...impact, date: "2026-02-30" }).success).toBe(false);
    expect(derivedImpactSchema.safeParse({ ...impact, date: "not-a-date" }).success).toBe(false);
  });
});
