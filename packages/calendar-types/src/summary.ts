import type { DayType } from "./codes.js";

/**
 * The summary derivation (DESIGN schedule 8, Issue #47), carried
 * over from the prototype's getSummary (school-schedule
 * server/src/actions.ts) and adapted to this implementation's
 * shapes: day types are the platform's fixed codes, a value's
 * "counts" is resolved by the caller from its option's
 * counts_as_json, and the answer is bucketed by month as well as
 * totalled, because the screens show it both ways (the foot of a
 * month table, and a year table with a row per month).
 *
 * Nothing here reads or writes storage: the counts are derived
 * from the days and the daily values on every call, so changing
 * a day's type or a day's symbol changes the next summary —
 * there is no stored total to drift (DESIGN schedule 8).
 */

/** The day types a summary reports, in their fixed order. Every
 *  type stands in every period's counts, at zero when the period
 *  holds none, so a table's rows never change shape by month. */
export const SUMMARY_DAY_TYPES: readonly DayType[] = [
  "class_day",
  "event_day",
  "attendance_day",
  "closed_day",
  "long_vacation",
];

/** One date of the range with its resolved day type: the caller
 *  has already applied the day rule (the platform's record, the
 *  holiday list, the weekday default), exactly as the range read
 *  resolves it, so the summary and the table it foots agree. */
export interface SummaryDayInput {
  date: string;
  dayType: DayType;
}

/** One item the summary counts, in the order they are reported. */
export interface SummaryItemInput {
  itemId: string;
  name: string;
}

/**
 * One daily value of a counted item, reduced to what the
 * counting reads: its date, its target (null for a value that is
 * not split by target), and whether its symbol counts — the
 * caller resolves that from the value's option
 * (item_options.counts_as_json) so this function never has to
 * know the condition's shape.
 */
export interface SummaryValueInput {
  date: string;
  itemId: string;
  targetId: string | null;
  counts: boolean;
}

/** A target a value may name, with the name the summary shows.
 *  The order is the order per-target counts are reported in. */
export interface SummaryTargetInput {
  targetId: string;
  name: string;
}

export interface SummaryDayTypeCount {
  dayType: DayType;
  count: number;
}

export interface SummaryTargetCount {
  targetId: string | null;
  targetName: string;
  count: number;
}

export interface SummaryItemCount {
  itemId: string;
  name: string;
  /** The distinct days on which the item counts for at least
   *  one target — a day two targets count, or a morning and an
   *  afternoon row both count, is still one day. */
  total: number;
  /** Per-target distinct days, for the targets that carry any
   *  value of this item in the period (a target whose values
   *  never count stands at zero — the exception the design
   *  names, e.g. the sixth years' lunch on their trip days).
   *  The unsplit target (null) stands first. */
  byTarget: SummaryTargetCount[];
}

export interface SummaryPeriod {
  /** The days of the period whose type is class_day. */
  schoolDays: number;
  dayTypeCounts: SummaryDayTypeCount[];
  items: SummaryItemCount[];
}

export interface SummaryMonth extends SummaryPeriod {
  /** The month, as YYYY-MM. */
  month: string;
}

export interface SummaryResult {
  /** One bucket per month the range touches, in month order. */
  months: SummaryMonth[];
  /** The whole range, counted as one period. */
  total: SummaryPeriod;
}

function summarizePeriod(
  days: readonly SummaryDayInput[],
  items: readonly SummaryItemInput[],
  values: readonly SummaryValueInput[],
  targets: readonly SummaryTargetInput[],
): SummaryPeriod {
  const countByType = new Map<DayType, number>();
  for (const day of days) {
    countByType.set(day.dayType, (countByType.get(day.dayType) ?? 0) + 1);
  }
  const nameOf = (targetId: string): string =>
    targets.find((t) => t.targetId === targetId)?.name ?? targetId;
  const orderOf = (targetId: string | null): number => {
    if (targetId === null) return -1;
    const index = targets.findIndex((t) => t.targetId === targetId);
    return index === -1 ? targets.length : index;
  };
  return {
    schoolDays: countByType.get("class_day") ?? 0,
    dayTypeCounts: SUMMARY_DAY_TYPES.map((dayType) => ({
      dayType,
      count: countByType.get(dayType) ?? 0,
    })),
    items: items.map((item) => {
      const countedDays = new Set<string>();
      const countedByTarget = new Map<string | null, Set<string>>();
      const seenTargets = new Set<string | null>();
      for (const value of values) {
        if (value.itemId !== item.itemId) continue;
        seenTargets.add(value.targetId);
        if (!value.counts) continue;
        countedDays.add(value.date);
        const set = countedByTarget.get(value.targetId) ?? new Set<string>();
        set.add(value.date);
        countedByTarget.set(value.targetId, set);
      }
      const byTarget = [...seenTargets]
        .sort((a, b) => orderOf(a) - orderOf(b))
        .map((targetId) => ({
          targetId,
          targetName: targetId === null ? "全体" : nameOf(targetId),
          count: countedByTarget.get(targetId)?.size ?? 0,
        }));
      return { itemId: item.itemId, name: item.name, total: countedDays.size, byTarget };
    }),
  };
}

/**
 * Counts a range: per month and in total, the school days (from
 * the days' types) and, for each item, the days its symbol
 * counts, overall and per target (DESIGN schedule 8: exceptions
 * such as one grade's different lunch count are reproduced by
 * the per-target values themselves, so the counting is done per
 * target axis).
 */
export function summarizeRange(input: {
  days: readonly SummaryDayInput[];
  items: readonly SummaryItemInput[];
  values: readonly SummaryValueInput[];
  targets: readonly SummaryTargetInput[];
}): SummaryResult {
  const months: SummaryMonth[] = [];
  const monthOf = (date: string): string => date.slice(0, 7);
  const monthKeys = [...new Set(input.days.map((d) => monthOf(d.date)))].sort();
  for (const month of monthKeys) {
    months.push({
      month,
      ...summarizePeriod(
        input.days.filter((d) => monthOf(d.date) === month),
        input.items,
        input.values.filter((v) => monthOf(v.date) === month),
        input.targets,
      ),
    });
  }
  return {
    months,
    total: summarizePeriod(input.days, input.items, input.values, input.targets),
  };
}
