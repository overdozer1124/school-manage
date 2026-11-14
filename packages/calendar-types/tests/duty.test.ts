import { describe, expect, it } from "vitest";
import {
  addDays,
  datesInRange,
  defaultDayType,
  deriveDutyConflicts,
  dutyAbsenceOverlapsSlot,
  dutyAppliesOn,
  eventSlot,
  isDutySlot,
  isInTerm,
  nextRotationIndex,
  planRotation,
  rankDutyCandidates,
  resolveDayFacts,
  slotsForGranularity,
  slotsOverlap,
  weekStartOf,
  type DutyAbsenceFact,
  type DutyAssignmentFact,
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

// Conflict derivation and candidates (Issue #31). The derivation
// follows the prototype's computeConflicts (school-schedule
// actions.ts), which had no unit tests of its own — the cases
// below pin its behaviour in this implementation's shapes:
// holders and absences matched by staff-master id, absences as
// platform records with CalendarTime spans.

describe("dutyAbsenceOverlapsSlot", () => {
  it("a half-day absence only meets its own half", () => {
    const am = { kind: "half_day", half: "am" } as const;
    const pm = { kind: "half_day", half: "pm" } as const;
    expect(dutyAbsenceOverlapsSlot("am", am)).toBe(true);
    expect(dutyAbsenceOverlapsSlot("pm", am)).toBe(false);
    expect(dutyAbsenceOverlapsSlot("am", pm)).toBe(false);
    expect(dutyAbsenceOverlapsSlot("all_day", am)).toBe(true);
    expect(dutyAbsenceOverlapsSlot("week", pm)).toBe(true);
  });
  it("an all-day absence meets every slot", () => {
    expect(dutyAbsenceOverlapsSlot("pm", { kind: "all_day" })).toBe(true);
    expect(dutyAbsenceOverlapsSlot("3", { kind: "all_day" })).toBe(true);
  });
  it("a clock absence is placed by its hours", () => {
    const morning = { kind: "clock", startsAt: "08:30", endsAt: "11:00" } as const;
    expect(dutyAbsenceOverlapsSlot("am", morning)).toBe(true);
    expect(dutyAbsenceOverlapsSlot("pm", morning)).toBe(false);
    const spanning = { kind: "clock", startsAt: "10:00", endsAt: "15:00" } as const;
    expect(dutyAbsenceOverlapsSlot("pm", spanning)).toBe(true);
  });
  it("a periods absence meets a period duty by the numbers, and warns elsewhere", () => {
    const periods = { kind: "periods", from: 1, to: 2 } as const;
    expect(dutyAbsenceOverlapsSlot("2", periods)).toBe(true);
    expect(dutyAbsenceOverlapsSlot("3", periods)).toBe(false);
    // Without the day pattern the half cannot be decided: warn.
    expect(dutyAbsenceOverlapsSlot("pm", periods)).toBe(true);
    expect(dutyAbsenceOverlapsSlot("3", { kind: "half_day", half: "am" })).toBe(true);
  });
});

describe("deriveDutyConflicts", () => {
  const names = { "duty-day": "日直", "duty-ampm": "日番", "duty-week": "週番" };
  const assignment = (o: Partial<DutyAssignmentFact>): DutyAssignmentFact => ({
    id: "asg-1",
    dutyDefinitionId: "duty-day",
    date: "2026-04-06",
    slot: "all_day",
    personId: "teacher-1",
    origin: "auto",
    ...o,
  });
  const absence = (o: Partial<DutyAbsenceFact>): DutyAbsenceFact => ({
    id: "abs-1",
    staffId: "teacher-1",
    kind: "business_trip",
    certainty: "confirmed",
    fromDate: "2026-04-06",
    toDate: "2026-04-06",
    time: { kind: "all_day" },
    ...o,
  });
  const base = {
    from: "2026-04-06",
    to: "2026-04-06",
    assignments: [] as DutyAssignmentFact[],
    absences: [] as DutyAbsenceFact[],
    waivers: [] as { assignmentId: string; absenceId: string }[],
    absenceKinds: null,
    expectedCells: [] as { dutyDefinitionId: string; date: string; slot: string }[],
    dutyNames: names,
  };

  it("an absence over the holder's slot conflicts, with its kind and certainty", () => {
    const conflicts = deriveDutyConflicts({
      ...base,
      assignments: [assignment({})],
      absences: [absence({ certainty: "tentative" })],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      kind: "absence",
      assignmentId: "asg-1",
      dutyName: "日直",
      personId: "teacher-1",
      absenceId: "abs-1",
      absenceKind: "business_trip",
      certainty: "tentative",
    });
  });

  it("a morning absence does not conflict with an afternoon duty", () => {
    const conflicts = deriveDutyConflicts({
      ...base,
      assignments: [assignment({ id: "asg-pm", dutyDefinitionId: "duty-ampm", slot: "pm" })],
      absences: [absence({ time: { kind: "half_day", half: "am" } })],
    });
    expect(conflicts).toEqual([]);
  });

  it("another person's absence, an out-of-range day, and a waived pair do not conflict", () => {
    expect(
      deriveDutyConflicts({
        ...base,
        assignments: [assignment({})],
        absences: [absence({ staffId: "teacher-2" })],
      }),
    ).toEqual([]);
    expect(
      deriveDutyConflicts({
        ...base,
        assignments: [assignment({})],
        absences: [absence({ fromDate: "2026-04-07", toDate: "2026-04-07" })],
      }),
    ).toEqual([]);
    expect(
      deriveDutyConflicts({
        ...base,
        assignments: [assignment({})],
        absences: [absence({})],
        waivers: [{ assignmentId: "asg-1", absenceId: "abs-1" }],
      }),
    ).toEqual([]);
  });

  it("the school's kind setting decides which absences count", () => {
    const input = {
      ...base,
      assignments: [assignment({})],
      absences: [absence({ kind: "leave" })],
    };
    expect(deriveDutyConflicts(input)).toHaveLength(1);
    expect(deriveDutyConflicts({ ...input, absenceKinds: ["business_trip"] })).toEqual([]);
    expect(deriveDutyConflicts({ ...input, absenceKinds: ["leave"] })).toHaveLength(1);
  });

  it("a week assignment conflicts on the absent day inside its week", () => {
    const conflicts = deriveDutyConflicts({
      ...base,
      from: "2026-04-06",
      to: "2026-04-12",
      assignments: [assignment({ id: "asg-week", dutyDefinitionId: "duty-week", slot: "week" })],
      absences: [absence({ fromDate: "2026-04-08", toDate: "2026-04-08" })],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: "absence", date: "2026-04-08", slot: "week" });
  });

  it("the same person on two duties at the same moment is a double", () => {
    const conflicts = deriveDutyConflicts({
      ...base,
      assignments: [
        assignment({ id: "asg-1" }),
        assignment({ id: "asg-2", dutyDefinitionId: "duty-ampm", slot: "am" }),
      ],
    });
    expect(conflicts).toHaveLength(1);
    // The pair's primary is the earlier assignment in cell order
    // (date, definition, slot, id): duty-ampm sorts before duty-day.
    expect(conflicts[0]).toMatchObject({
      kind: "double",
      assignmentId: "asg-2",
      otherAssignmentId: "asg-1",
      personId: "teacher-1",
    });
    // Morning and afternoon halves of one person are not a double.
    expect(
      deriveDutyConflicts({
        ...base,
        assignments: [
          assignment({ id: "asg-1", dutyDefinitionId: "duty-ampm", slot: "am" }),
          assignment({ id: "asg-2", dutyDefinitionId: "duty-ampm", slot: "pm" }),
        ],
      }),
    ).toEqual([]);
  });

  it("an applicable cell with no holder is unassigned, a hand-cleared cell is not", () => {
    const cell = { dutyDefinitionId: "duty-day", date: "2026-04-06", slot: "all_day" };
    const unassigned = deriveDutyConflicts({ ...base, expectedCells: [cell] });
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]).toMatchObject({ kind: "unassigned", assignmentId: null });
    // A manual row with no holder is a deliberate clearing (#30).
    expect(
      deriveDutyConflicts({
        ...base,
        expectedCells: [cell],
        assignments: [assignment({ personId: null, origin: "manual" })],
      }),
    ).toEqual([]);
    // A filled cell is not unassigned either.
    expect(
      deriveDutyConflicts({ ...base, expectedCells: [cell], assignments: [assignment({})] }),
    ).toEqual([]);
  });
});

describe("rankDutyCandidates", () => {
  const roster = ["teacher-1", "teacher-2", "teacher-3", "teacher-4"];
  const absence = (o: Partial<DutyAbsenceFact>): DutyAbsenceFact => ({
    id: "abs-1",
    staffId: "teacher-2",
    kind: "leave",
    certainty: "confirmed",
    fromDate: "2026-04-06",
    toDate: "2026-04-06",
    time: { kind: "all_day" },
    ...o,
  });
  const base = {
    roster,
    currentPersonId: "teacher-1",
    dates: ["2026-04-06"],
    slot: "all_day",
    absences: [] as DutyAbsenceFact[],
    assignments: [] as DutyAssignmentFact[],
  };

  it("nearest in the rotation first, wrapping around", () => {
    expect(rankDutyCandidates(base)).toEqual(["teacher-2", "teacher-3", "teacher-4"]);
    expect(rankDutyCandidates({ ...base, currentPersonId: "teacher-3" })).toEqual([
      "teacher-4",
      "teacher-1",
      "teacher-2",
    ]);
    expect(rankDutyCandidates({ ...base, currentPersonId: null })).toEqual([
      "teacher-1",
      "teacher-2",
      "teacher-3",
      "teacher-4",
    ]);
  });

  it("a person away that day is not a candidate, of any absence kind", () => {
    expect(rankDutyCandidates({ ...base, absences: [absence({})] })).toEqual([
      "teacher-3",
      "teacher-4",
    ]);
    // Away only in the morning: still a candidate for an afternoon duty.
    expect(
      rankDutyCandidates({
        ...base,
        slot: "pm",
        absences: [absence({ time: { kind: "half_day", half: "am" } })],
      }),
    ).toEqual(["teacher-2", "teacher-3", "teacher-4"]);
  });

  it("a person already holding an overlapping duty that day is not asked twice", () => {
    const busy: DutyAssignmentFact = {
      id: "asg-x",
      dutyDefinitionId: "duty-ampm",
      date: "2026-04-06",
      slot: "am",
      personId: "teacher-3",
      origin: "auto",
    };
    // An all-day takeover overlaps the morning duty.
    expect(rankDutyCandidates({ ...base, assignments: [busy] })).toEqual([
      "teacher-2",
      "teacher-4",
    ]);
    // An afternoon takeover does not.
    expect(rankDutyCandidates({ ...base, slot: "pm", assignments: [busy] })).toEqual([
      "teacher-2",
      "teacher-3",
      "teacher-4",
    ]);
  });
});
