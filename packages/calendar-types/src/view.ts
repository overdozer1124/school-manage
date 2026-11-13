import { z } from "zod";
import { AUDIENCE_FLOOR, VISIBILITY_REACH, type Audience } from "./audience.js";
import type { Visibility } from "./codes.js";

/**
 * View definitions and the pure functions over them (Issue #32):
 * the audience whitelist of DESIGN schedule 9 and the same-value
 * grouping of DESIGN schedule 4.8.2, shared by the schedule server
 * and the screens, per DESIGN-INTEGRATION 7.2.
 *
 * The whitelist functions are a port of the prototype's
 * client/src/audience.ts (school-schedule repo, frozen). The port
 * keeps the prototype's semantics and its test expectations; the
 * differences are only in the data shapes of this implementation:
 * ids are strings, a column's kind is the view_columns source_kind
 * (event_category / daily_item / duty / day_attribute), and a duty
 * column names its definition with dutyDefinitionId. The range
 * filter is generic over the range shape: this implementation has
 * no single RangeData type yet (period bundling is a later issue),
 * so any object carrying the five arrays can be passed and keeps
 * its other fields untouched.
 *
 * The event-side audience filter (visibility of calendar events)
 * lives in audience.ts; this module is about views: which columns
 * and items a view's audience may see at all (whitelist), and how
 * per-target values are labelled when some targets share a value.
 */

/** The standard layouts of DESIGN schedule 4.8.1 plus the extension
 *  layout. Phase 2 values are accepted here; whether a screen can
 *  render one is the screen's concern, not the definition's. */
export const viewLayoutSchema = z.enum([
  "month_rows",
  "week_rows",
  "year_columns",
  "calendar_grid",
  "week_timeline",
  "transposed",
]);
export type ViewLayout = z.infer<typeof viewLayoutSchema>;

/** What a view covers (DESIGN schedule 4.8: 週/2週間/月/年). */
export const periodScopeSchema = z.enum(["week", "two_weeks", "month", "year"]);
export type PeriodScope = z.infer<typeof periodScopeSchema>;

/** What a view column draws (DESIGN schedule 4.8, view_columns). */
export const viewColumnSourceKindSchema = z.enum([
  "event_category",
  "daily_item",
  "duty",
  "day_attribute",
]);
export type ViewColumnSourceKind = z.infer<typeof viewColumnSourceKindSchema>;

/**
 * The rank of a view audience (DESIGN-AUTH-TENANCY 4.5: the
 * effective rank of a read through a view is
 * max(0, the view audience's rank), so staff previewing a student
 * view see it exactly as students do). Ported from the prototype:
 * an unknown audience string falls back to the most open audience,
 * never to staff; null / undefined means no view audience was
 * given, which is the staff context itself.
 */
export function audienceRankOf(audience: string | null | undefined): number {
  if (audience == null) return 0;
  return AUDIENCE_FLOOR[audience as Audience] ?? AUDIENCE_FLOOR.public;
}

/** The effective rank of a read through a view (DESIGN-AUTH-TENANCY 4.5). */
export function viewAudienceRank(audience: Audience): number {
  return Math.max(0, audienceRankOf(audience));
}

/**
 * Whether something with this visibility may be shown to the given
 * audience rank. Unknown visibility counts as staff-only (ported).
 */
export function visibilityReaches(visibility: string, audienceRank: number): boolean {
  return (VISIBILITY_REACH[visibility as Visibility] ?? 0) >= audienceRank;
}

/** The slice of a view column the whitelist reads. */
export interface AudienceColumn {
  sourceKind: ViewColumnSourceKind;
  itemDefinitionId?: string | null;
  dutyDefinitionId?: string | null;
}

/** The slice of an item definition the whitelist reads. */
export interface AudienceItem {
  id: string;
  defaultVisibility: Visibility;
}

/**
 * View columns that the audience may see (ported): daily items by
 * their definition's visibility, duties only for staff (they carry
 * people's names), event categories and day attributes always.
 */
export function audienceColumns<C extends AudienceColumn>(
  columns: readonly C[],
  items: readonly Pick<AudienceItem, "id" | "defaultVisibility">[],
  audienceRank: number,
): C[] {
  return columns.filter((c) => {
    if (c.sourceKind === "daily_item") {
      const item = items.find((i) => i.id === c.itemDefinitionId);
      if (!item) return false;
      return visibilityReaches(item.defaultVisibility, audienceRank);
    }
    if (c.sourceKind === "duty") return audienceRank === 0;
    return true;
  });
}

/**
 * Daily items the audience may see anywhere on screen (ported).
 * Staff see every item; any other audience sees only items that are
 * columns of the view AND whose visibility reaches it (whitelist,
 * not "hide what is secret", DESIGN schedule 9).
 */
export function audienceItems<T extends Pick<AudienceItem, "id" | "defaultVisibility">>(
  items: readonly T[],
  visibleColumns: readonly AudienceColumn[],
  audienceRank: number,
): T[] {
  if (audienceRank === 0) return [...items];
  const ids = new Set(
    visibleColumns
      .filter((c) => c.sourceKind === "daily_item")
      .map((c) => c.itemDefinitionId)
      .filter((id): id is string => id != null),
  );
  return items.filter((i) => ids.has(i.id) && visibilityReaches(i.defaultVisibility, audienceRank));
}

/** The range fields the audience filter owns; a concrete range may
 *  carry more fields, which pass through untouched. */
export interface AudienceRangeData {
  events: readonly { visibility: Visibility }[];
  dailyValues: readonly { itemDefinitionId: string }[];
  dutyAssignments: readonly unknown[];
  conflicts: readonly unknown[];
  dutyChanges: readonly unknown[];
}

/**
 * The range data a view may render (ported). Staff get it
 * unchanged (the same object). Other audiences get events filtered
 * by visibility, daily values only for the allowed items, and no
 * duty assignments, conflicts or duty history (those carry staff
 * names and are staff-only by definition).
 */
export function filterRangeForAudience<T extends AudienceRangeData>(
  range: T,
  allowedItemIds: ReadonlySet<string>,
  audienceRank: number,
): T {
  if (audienceRank === 0) return range;
  return {
    ...range,
    events: range.events.filter((e) => visibilityReaches(e.visibility, audienceRank)),
    dailyValues: range.dailyValues.filter((d) => allowedItemIds.has(d.itemDefinitionId)),
    dutyAssignments: [],
    conflicts: [],
    dutyChanges: [],
  };
}

/**
 * Compresses an ordered list of consecutive target names into a
 * label (ported from the prototype). ["1年",…,"6年"] -> "1～6年"
 * (shared suffix kept once); a single name is returned as-is.
 * Names without a shared numeric shape （学部名・部門名など) are
 * listed instead of ranged (DESIGN schedule 4.8.2):
 * ["小学部","中学部"] -> "小学部・中学部".
 */
export function targetRangeLabel(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  const first = names[0] ?? "";
  const last = names[names.length - 1] ?? "";
  const fm = first.match(/^(\d+)(.*)$/);
  const lm = last.match(/^(\d+)(.*)$/);
  if (fm && lm && fm[2] !== "" && fm[2] === lm[2]) {
    return `${fm[1]}～${last}`;
  }
  return names.join("・");
}

/** One target's value for grouping: its short display name in axis
 *  order, and the value, or null when the target has no value (it
 *  then takes no part in the display, DESIGN schedule 4.8.2: the
 *  data is per-target and only valued targets are shown). */
export interface TargetValue {
  name: string;
  value: string | null;
}

/** A block of targets shown together because they share a value. */
export interface ValueGroup {
  /** Display label of the block's targets (see groupLabel). */
  label: string;
  value: string;
  /** The block's target names, in axis order. */
  names: string[];
}

/**
 * The label of one group of targets (DESIGN schedule 4.8.2). The
 * design's own examples enumerate a pair instead of ranging it
 * (5・6年, 1・2年） and range only three or more consecutive
 * numeric targets (1～4年, 4～6年), so a consecutive run of three
 * or more numeric names with a shared suffix becomes a range, and
 * everything else — pairs, non-consecutive members (1・3年）, and
 * non-numeric names （小学部・中学部） — is enumerated, the shared
 * suffix kept once. This differs deliberately from
 * targetRangeLabel above, which ranges any run of two or more and
 * is kept as ported for the prototype's other uses.
 */
function groupLabel(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  const parsed = names.map((n) => n.match(/^(\d+)(.*)$/));
  const suffix = parsed[0]?.[2];
  const numeric =
    suffix !== undefined && suffix !== "" && parsed.every((m) => m !== null && m[2] === suffix);
  if (!numeric) return names.join("・");
  const numbers = parsed.map((m) => Number((m as RegExpMatchArray)[1]));
  const parts: string[] = [];
  let runStart = 0;
  const flush = (endExclusive: number) => {
    const run = numbers.slice(runStart, endExclusive);
    if (run.length >= 3) {
      parts.push(`${run[0]}～${run[run.length - 1]}${suffix}`);
    } else {
      for (const n of run) parts.push(`${n}`);
    }
  };
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] !== (numbers[i - 1] as number) + 1) {
      flush(i);
      runStart = i;
    }
  }
  flush(numbers.length);
  const joined = parts.join("・");
  return joined.endsWith(suffix as string) ? joined : `${joined}${suffix}`;
}

/**
 * Groups per-target values for display (DESIGN schedule 4.8.2).
 * Entries are in the axis's sort order; entries without a value do
 * not appear. Blocks are maximal runs of consecutive entries with
 * the same value: changing one target's value splits its block in
 * three （1・2年／3年／4～6年）, it never merges the same value
 * across a different one. With groupSameValues false (the
 * view_columns switch, for views that give every target its own
 * column), every valued target is its own block.
 */
export function groupSameValues(
  entries: readonly TargetValue[],
  options: { groupSameValues?: boolean } = {},
): ValueGroup[] {
  const valued = entries.filter(
    (e): e is { name: string; value: string } => e.value !== null && e.value !== undefined,
  );
  if (options.groupSameValues === false) {
    return valued.map((e) => ({ label: e.name, value: e.value, names: [e.name] }));
  }
  const groups: ValueGroup[] = [];
  for (const entry of valued) {
    const last = groups[groups.length - 1];
    if (last && last.value === entry.value) {
      last.names.push(entry.name);
      last.label = groupLabel(last.names);
    } else {
      groups.push({ label: entry.name, value: entry.value, names: [entry.name] });
    }
  }
  return groups;
}

/** The one-line display of grouped values: `1～4年 14:30～14:40／5・6年 15:20～15:30`. */
export function formatGroupedValues(
  entries: readonly TargetValue[],
  options: { groupSameValues?: boolean } = {},
): string {
  return groupSameValues(entries, options)
    .map((g) => `${g.label} ${g.value}`)
    .join("／");
}
