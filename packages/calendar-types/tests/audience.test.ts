import { describe, expect, it } from "vitest";
import {
  calendarEventRecordSchema,
  coversSchoolYear,
  eventDateSpan,
  eventInRange,
  filterVisible,
  forAudience,
  isVisibleTo,
  type Visibility,
} from "../src/index.js";

describe("isVisibleTo", () => {
  const audiences = ["staff", "guardian", "student", "public"] as const;
  const table: Record<Visibility, boolean[]> = {
    //                 staff  guardian student public
    staff_only: [true, false, false, false],
    guardian: [true, true, false, false],
    student: [true, true, true, false],
    public: [true, true, true, true],
  };
  for (const [visibility, expected] of Object.entries(table) as [Visibility, boolean[]][]) {
    it(`visibility ${visibility}`, () => {
      audiences.forEach((audience, i) => {
        expect(isVisibleTo(visibility, audience)).toBe(expected[i]);
      });
    });
  }

  it("filterVisible keeps only what the audience may see, in order", () => {
    const events = [
      { id: "a", visibility: "public" as const },
      { id: "b", visibility: "staff_only" as const },
      { id: "c", visibility: "guardian" as const },
    ];
    expect(filterVisible(events, "guardian").map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterVisible(events, "staff").map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});

describe("forAudience", () => {
  const event = {
    title: "職員会議",
    assignees: [
      { kind: "staff" as const, staffId: "staff-1", role: "担当" },
      { kind: "free_text" as const, name: "外部講師", role: null },
    ],
    targets: [
      { axis: "grade" as const, id: "grade-7" },
      { axis: "staff" as const, id: "staff-1" },
    ],
    impacts: [
      {
        kind: "block_periods" as const,
        periods: { from: 1, to: 4 },
        targets: [
          { axis: "grade" as const, id: "grade-7" },
          { axis: "staff" as const, id: "staff-2" },
        ],
      },
      { kind: "room_use" as const, roomId: "gym", time: { kind: "all_day" as const } },
    ],
  };

  it("keeps assignees for staff and drops them for everyone else", () => {
    expect(forAudience(event, "staff").assignees).toHaveLength(2);
    for (const audience of ["guardian", "student", "public"] as const) {
      expect(forAudience(event, audience).assignees).toEqual([]);
    }
  });

  it("drops staff-axis targets (event and impact) for non-staff audiences", () => {
    const forStaff = forAudience(event, "staff");
    expect(forStaff.targets).toHaveLength(2);
    const forGuardian = forAudience(event, "guardian");
    expect(forGuardian.targets).toEqual([{ axis: "grade", id: "grade-7" }]);
    expect(forGuardian.impacts[0]).toMatchObject({
      kind: "block_periods",
      targets: [{ axis: "grade", id: "grade-7" }],
    });
    expect(forGuardian.impacts[1]).toEqual(event.impacts[1]);
  });

  it("does not mutate the original event", () => {
    forAudience(event, "guardian");
    expect(event.assignees).toHaveLength(2);
    expect(event.targets).toHaveLength(2);
  });
});

describe("event ranges", () => {
  it("spans a month-precision event over its whole month", () => {
    expect(eventDateSpan({ datePrecision: "month", startsOn: "2026-11-15", endsOn: null })).toEqual(
      { start: "2026-11-01", end: "2026-11-30" },
    );
    expect(
      eventInRange(
        { datePrecision: "month", startsOn: "2026-11-15", endsOn: null },
        "2026-11-20",
        "2026-11-25",
      ),
    ).toBe(true);
    expect(
      eventInRange(
        { datePrecision: "month", startsOn: "2026-11-15", endsOn: null },
        "2026-12-01",
        "2026-12-31",
      ),
    ).toBe(false);
  });

  it("matches day and range events by overlap", () => {
    const range = { datePrecision: "range" as const, startsOn: "2026-11-10", endsOn: "2026-11-12" };
    expect(eventInRange(range, "2026-11-12", "2026-11-30")).toBe(true);
    expect(eventInRange(range, "2026-11-13", "2026-11-30")).toBe(false);
    const day = { datePrecision: "day" as const, startsOn: "2026-11-10", endsOn: null };
    expect(eventInRange(day, "2026-11-01", "2026-11-30")).toBe(true);
    expect(eventInRange(day, "2026-12-01", "2026-12-31")).toBe(false);
  });

  it("returns undecided events only for a full school-year range", () => {
    const undecided = { datePrecision: "undecided" as const, startsOn: "2026-04-01", endsOn: null };
    expect(eventDateSpan(undecided)).toBeNull();
    expect(coversSchoolYear("2026-04-01", "2027-03-31")).toBe(true);
    expect(coversSchoolYear("2026-01-01", "2026-12-31")).toBe(false);
    expect(eventInRange(undecided, "2026-04-01", "2027-03-31")).toBe(true);
    expect(eventInRange(undecided, "2026-04-01", "2027-03-30")).toBe(false);
    expect(eventInRange(undecided, "2026-11-01", "2026-11-30")).toBe(false);
  });

  it("returns an undecided event only in its own school year", () => {
    const undecided2026 = {
      datePrecision: "undecided" as const,
      startsOn: "2026-04-01",
      endsOn: null,
    };
    const undecided2027 = {
      datePrecision: "undecided" as const,
      startsOn: "2027-04-01",
      endsOn: null,
    };
    // Each school-year query returns only its own year's event.
    expect(eventInRange(undecided2026, "2026-04-01", "2027-03-31")).toBe(true);
    expect(eventInRange(undecided2027, "2026-04-01", "2027-03-31")).toBe(false);
    expect(eventInRange(undecided2026, "2027-04-01", "2028-03-31")).toBe(false);
    expect(eventInRange(undecided2027, "2027-04-01", "2028-03-31")).toBe(true);
    // A range covering both years returns both.
    expect(eventInRange(undecided2026, "2026-04-01", "2028-03-31")).toBe(true);
    expect(eventInRange(undecided2027, "2026-04-01", "2028-03-31")).toBe(true);
    // An undecided event without a year belongs to no year.
    expect(
      eventInRange(
        { datePrecision: "undecided", startsOn: null, endsOn: null },
        "2026-04-01",
        "2027-03-31",
      ),
    ).toBe(false);
  });
});

describe("calendarEventRecordSchema", () => {
  const base = {
    schoolId: "school-1",
    id: "event-1",
    revision: 1,
    createdBy: "person-1",
    updatedBy: "person-1",
    updatedVia: "platform" as const,
    title: "音楽祭",
    kind: "event" as const,
    kindLabel: null,
    datePrecision: "day" as const,
    startsOn: "2026-11-10",
    endsOn: null,
    time: { kind: "periods" as const, from: 1, to: 4 },
    locationId: null,
    locationText: "体育館",
    description: null,
    certainty: "confirmed" as const,
    visibility: "guardian" as const,
    targets: [{ axis: "grade" as const, id: "grade-7" }],
    impacts: [
      {
        kind: "block_periods" as const,
        periods: { from: 1, to: 4 },
        targets: [{ axis: "app" as const, app: "schedule" as const, axisKey: "club", id: "brass" }],
      },
    ],
    assignees: [{ kind: "staff" as const, staffId: "staff-1", role: "担当" }],
  };

  it("accepts a full record", () => {
    expect(calendarEventRecordSchema.safeParse(base).success).toBe(true);
  });

  it("accepts an undecided record whose startsOn is April 1 of its school year", () => {
    expect(
      calendarEventRecordSchema.safeParse({
        ...base,
        datePrecision: "undecided",
        startsOn: "2026-04-01",
        endsOn: null,
      }).success,
    ).toBe(true);
  });

  it("rejects date shapes that contradict the precision", () => {
    // base startsOn is 2026-11-10, not April 1, so undecided fails.
    expect(
      calendarEventRecordSchema.safeParse({ ...base, datePrecision: "undecided" }).success,
    ).toBe(false);
    expect(
      calendarEventRecordSchema.safeParse({
        ...base,
        datePrecision: "undecided",
        startsOn: null,
      }).success,
    ).toBe(false);
    expect(
      calendarEventRecordSchema.safeParse({
        ...base,
        datePrecision: "range",
        endsOn: "2026-11-09",
      }).success,
    ).toBe(false);
    expect(calendarEventRecordSchema.safeParse({ ...base, endsOn: "2026-11-11" }).success).toBe(
      false,
    );
    expect(
      calendarEventRecordSchema.safeParse({
        ...base,
        datePrecision: "month",
        endsOn: "2026-12-01",
      }).success,
    ).toBe(false);
  });
});
