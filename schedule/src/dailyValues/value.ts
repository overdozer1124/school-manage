import { isValidTimeString, timeToMinutes, type TargetRef } from "@school-manage/calendar-types";
import type { ValueType } from "../definitions/types.js";

/**
 * Pure validation for daily values (Issue #28): a raw value from a
 * caller is checked against the item definition's value type and
 * turned into the typed-column set the daily_values row stores
 * (DESIGN schedule 4.6; the column form follows EventValue in 4.5).
 * No database access happens here — the item's options are passed
 * in — so every rule is unit-testable, and the actions run this
 * before any write, including for every entry of a bulk set.
 */

export interface DailyValueColumns {
  valueText: string | null;
  valueTime: string | null;
  valueTimeEnd: string | null;
  valueNumber: number | null;
  valueBoolean: boolean | null;
  valueOptionId: string | null;
  valuePersonId: string | null;
  valueJson: unknown | null;
}

export function emptyDailyValueColumns(): DailyValueColumns {
  return {
    valueText: null,
    valueTime: null,
    valueTimeEnd: null,
    valueNumber: null,
    valueBoolean: null,
    valueOptionId: null,
    valuePersonId: null,
    valueJson: null,
  };
}

export interface ItemOptionRef {
  id: string;
  code: string;
}

function fail(message: string): never {
  throw new Error(`invalid daily value: ${message}`);
}

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${what} must be a non-empty string`);
  }
  return value as string;
}

function timeString(value: unknown, what: string): string {
  if (typeof value !== "string" || !isValidTimeString(value)) {
    fail(`${what} must be a time as HH:MM (00:00-23:59)`);
  }
  return value as string;
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${what} must be a non-empty array of strings`);
  }
  return value.map((entry, i) => nonEmptyString(entry, `${what}[${i}]`));
}

/**
 * Checks `value` against `valueType` and returns the columns to
 * store. Throws an Error describing the mismatch. For the
 * option-backed types (symbol, code) the value is an option code
 * and must exist in `options`; the stored column is the option's
 * id, as EventValue prescribes (DESIGN schedule 4.5).
 */
export function validateDailyValue(
  valueType: ValueType,
  options: readonly ItemOptionRef[],
  value: unknown,
): DailyValueColumns {
  const columns = emptyDailyValueColumns();
  switch (valueType) {
    case "text":
      columns.valueText = nonEmptyString(value, "text value");
      return columns;
    case "event_list":
      columns.valueJson = stringList(value, "event_list value");
      return columns;
    case "time":
      columns.valueTime = timeString(value, "time value");
      return columns;
    case "time_range": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("time_range value must be an object { startsAt, endsAt }");
      }
      const range = value as { startsAt?: unknown; endsAt?: unknown };
      const startsAt = timeString(range.startsAt, "time_range startsAt");
      const endsAt = timeString(range.endsAt, "time_range endsAt");
      if (timeToMinutes(endsAt) <= timeToMinutes(startsAt)) {
        fail("time_range endsAt must be after startsAt");
      }
      columns.valueTime = startsAt;
      columns.valueTimeEnd = endsAt;
      return columns;
    }
    case "symbol":
    case "code": {
      const code = nonEmptyString(value, `${valueType} value`);
      const option = options.find((o) => o.code === code);
      if (!option) {
        fail(`unknown ${valueType} code for this item: ${code}`);
      }
      columns.valueOptionId = option.id;
      return columns;
    }
    case "person":
      columns.valuePersonId = nonEmptyString(value, "person value");
      return columns;
    case "persons":
      columns.valueJson = stringList(value, "persons value");
      return columns;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail("number value must be a finite number");
      }
      columns.valueNumber = value;
      return columns;
    case "boolean":
      if (typeof value !== "boolean") {
        fail("boolean value must be true or false");
      }
      columns.valueBoolean = value;
      return columns;
    case "target_time_map": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("target_time_map value must be an object mapping target ids to times");
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        fail("target_time_map value must have at least one entry");
      }
      const map: Record<string, string> = {};
      for (const [targetId, at] of entries) {
        if (targetId.length === 0) {
          fail("target_time_map keys must be non-empty target ids");
        }
        map[targetId] = timeString(at, `target_time_map value for ${targetId}`);
      }
      columns.valueJson = map;
      return columns;
    }
  }
}

/**
 * The stored form of a slot (DESIGN schedule 4.6): "all_day", "am",
 * "pm", or a period number kept as its decimal string (0 is the
 * morning band, 99 after school, as in 4.2). Action inputs accept
 * the number form for periods; this normalizes and validates.
 */
export function normalizeSlot(slot: "all_day" | "am" | "pm" | number): string {
  if (slot === "all_day" || slot === "am" || slot === "pm") return slot;
  if (typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot <= 99) {
    return String(slot);
  }
  throw new Error(
    `invalid slot: ${String(slot)} (expected "all_day", "am", "pm" or a period number 0-99)`,
  );
}

/**
 * The canonical key of a target, stored on the row so the cell
 * uniqueness holds with nullable target columns (see schema.ts).
 */
export function targetKeyOf(target: TargetRef | null | undefined): string {
  if (!target) return "";
  return target.axis === "app" ? `app:${target.id}` : `${target.axis}:${target.id}`;
}
