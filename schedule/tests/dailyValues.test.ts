import { describe, expect, it } from "vitest";
import { normalizeSlot, targetKeyOf, validateDailyValue } from "../src/dailyValues/value.js";

// Unit tests for the pure daily-value validator (Issue #28): every
// value type of DESIGN schedule 4.4 accepts its own shape and
// refuses the others, without a database.
const OPTIONS = [
  { id: "opt-yes", code: "yes" },
  { id: "opt-no", code: "no" },
];

describe("validateDailyValue", () => {
  it("text takes a non-empty string and nothing else", () => {
    expect(validateDailyValue("text", [], "メモ").valueText).toBe("メモ");
    expect(() => validateDailyValue("text", [], "")).toThrow("non-empty string");
    expect(() => validateDailyValue("text", [], 42)).toThrow("non-empty string");
    expect(() => validateDailyValue("text", [], null)).toThrow("non-empty string");
  });

  it("event_list takes a non-empty list of strings", () => {
    expect(validateDailyValue("event_list", [], ["職員会議", "PTA"]).valueJson).toEqual([
      "職員会議",
      "PTA",
    ]);
    expect(() => validateDailyValue("event_list", [], [])).toThrow("non-empty array");
    expect(() => validateDailyValue("event_list", [], ["ok", ""])).toThrow("non-empty string");
    expect(() => validateDailyValue("event_list", [], "職員会議")).toThrow("non-empty array");
  });

  it("time takes HH:MM only", () => {
    expect(validateDailyValue("time", [], "14:30").valueTime).toBe("14:30");
    expect(validateDailyValue("time", [], "00:00").valueTime).toBe("00:00");
    expect(() => validateDailyValue("time", [], "24:00")).toThrow("HH:MM");
    expect(() => validateDailyValue("time", [], "9:05")).toThrow("HH:MM");
    expect(() => validateDailyValue("time", [], "14:60")).toThrow("HH:MM");
    expect(() => validateDailyValue("time", [], 1430)).toThrow("HH:MM");
  });

  it("time_range takes an ordered pair of times", () => {
    const columns = validateDailyValue("time_range", [], {
      startsAt: "14:30",
      endsAt: "14:40",
    });
    expect(columns.valueTime).toBe("14:30");
    expect(columns.valueTimeEnd).toBe("14:40");
    expect(() =>
      validateDailyValue("time_range", [], { startsAt: "14:40", endsAt: "14:30" }),
    ).toThrow("after startsAt");
    expect(() =>
      validateDailyValue("time_range", [], { startsAt: "14:30", endsAt: "14:30" }),
    ).toThrow("after startsAt");
    expect(() => validateDailyValue("time_range", [], { startsAt: "14:30" })).toThrow("HH:MM");
    expect(() => validateDailyValue("time_range", [], "14:30")).toThrow("object");
  });

  it("symbol and code take an existing option code and store the option id", () => {
    expect(validateDailyValue("symbol", OPTIONS, "yes").valueOptionId).toBe("opt-yes");
    expect(validateDailyValue("code", OPTIONS, "no").valueOptionId).toBe("opt-no");
    expect(() => validateDailyValue("symbol", OPTIONS, "maybe")).toThrow("unknown symbol code");
    expect(() => validateDailyValue("code", OPTIONS, "maybe")).toThrow("unknown code code");
    expect(() => validateDailyValue("symbol", [], "yes")).toThrow("unknown symbol code");
    expect(() => validateDailyValue("symbol", OPTIONS, true)).toThrow("non-empty string");
  });

  it("person takes one id, persons a non-empty list of ids", () => {
    expect(validateDailyValue("person", [], "person-1").valuePersonId).toBe("person-1");
    expect(() => validateDailyValue("person", [], "")).toThrow("non-empty string");
    expect(() => validateDailyValue("person", [], ["person-1"])).toThrow("non-empty string");
    expect(validateDailyValue("persons", [], ["p-1", "p-2"]).valueJson).toEqual(["p-1", "p-2"]);
    expect(() => validateDailyValue("persons", [], [])).toThrow("non-empty array");
    expect(() => validateDailyValue("persons", [], "p-1")).toThrow("non-empty array");
  });

  it("number takes a finite number and nothing else", () => {
    expect(validateDailyValue("number", [], 5).valueNumber).toBe(5);
    expect(validateDailyValue("number", [], 0).valueNumber).toBe(0);
    expect(validateDailyValue("number", [], -1.5).valueNumber).toBe(-1.5);
    expect(() => validateDailyValue("number", [], "5")).toThrow("finite number");
    expect(() => validateDailyValue("number", [], Number.NaN)).toThrow("finite number");
    expect(() => validateDailyValue("number", [], Infinity)).toThrow("finite number");
  });

  it("boolean takes a real boolean", () => {
    expect(validateDailyValue("boolean", [], true).valueBoolean).toBe(true);
    expect(validateDailyValue("boolean", [], false).valueBoolean).toBe(false);
    expect(() => validateDailyValue("boolean", [], "true")).toThrow("true or false");
    expect(() => validateDailyValue("boolean", [], 1)).toThrow("true or false");
  });

  it("target_time_map takes target ids mapped to times", () => {
    expect(
      validateDailyValue("target_time_map", [], { "grade-1": "14:30", "grade-2": "15:20" })
        .valueJson,
    ).toEqual({ "grade-1": "14:30", "grade-2": "15:20" });
    expect(() => validateDailyValue("target_time_map", [], {})).toThrow("at least one entry");
    expect(() => validateDailyValue("target_time_map", [], { "grade-1": "25:00" })).toThrow(
      "HH:MM",
    );
    expect(() => validateDailyValue("target_time_map", [], ["14:30"])).toThrow("object");
  });

  it("leaves every other column null", () => {
    const columns = validateDailyValue("time", [], "08:00");
    expect(columns.valueText).toBeNull();
    expect(columns.valueNumber).toBeNull();
    expect(columns.valueBoolean).toBeNull();
    expect(columns.valueOptionId).toBeNull();
    expect(columns.valuePersonId).toBeNull();
    expect(columns.valueJson).toBeNull();
  });
});

describe("normalizeSlot", () => {
  it("keeps the named slots and stringifies period numbers", () => {
    expect(normalizeSlot("all_day")).toBe("all_day");
    expect(normalizeSlot("am")).toBe("am");
    expect(normalizeSlot("pm")).toBe("pm");
    expect(normalizeSlot(0)).toBe("0");
    expect(normalizeSlot(3)).toBe("3");
    expect(normalizeSlot(99)).toBe("99");
  });

  it("refuses out-of-range periods", () => {
    expect(() => normalizeSlot(-1)).toThrow("invalid slot");
    expect(() => normalizeSlot(100)).toThrow("invalid slot");
    expect(() => normalizeSlot(1.5)).toThrow("invalid slot");
  });
});

describe("targetKeyOf", () => {
  it("builds the canonical key for each target form", () => {
    expect(targetKeyOf(null)).toBe("");
    expect(targetKeyOf(undefined)).toBe("");
    expect(targetKeyOf({ axis: "grade", id: "grade-3" })).toBe("grade:grade-3");
    expect(
      targetKeyOf({ axis: "app", app: "schedule", axisKey: "bus_route", id: "tgt-bus-1" }),
    ).toBe("app:tgt-bus-1");
  });
});
