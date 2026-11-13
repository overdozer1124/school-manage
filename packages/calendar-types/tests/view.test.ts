import { describe, expect, it } from "vitest";
import {
  audienceColumns,
  audienceItems,
  audienceRankOf,
  filterRangeForAudience,
  formatGroupedValues,
  groupSameValues,
  targetRangeLabel,
  viewAudienceRank,
  type AudienceColumn,
  type Visibility,
} from "../src/index.js";

// View tests (Issue #32). The audience whitelist suites are a port
// of the prototype's client/src/audience.test.ts (school-schedule),
// with the data shapes of this implementation (string ids,
// source_kind column kinds); the expectations are the prototype's.
// The grouping suites use DESIGN schedule 4.8.2's own examples.

const items: { id: string; defaultVisibility: Visibility }[] = [
  { id: "1", defaultVisibility: "student" }, // 給食
  { id: "2", defaultVisibility: "staff_only" }, // 清掃
  { id: "3", defaultVisibility: "guardian" }, // 下校（保護者まで）
];
const columns: (AudienceColumn & { label: string })[] = [
  { sourceKind: "event_category", label: "行事" },
  { sourceKind: "daily_item", itemDefinitionId: "1", label: "給食" },
  { sourceKind: "daily_item", itemDefinitionId: "2", label: "清掃" },
  { sourceKind: "daily_item", itemDefinitionId: "3", label: "下校" },
  { sourceKind: "duty", dutyDefinitionId: "9", label: "日番" },
];

function range() {
  return {
    events: [
      { id: "1", visibility: "staff_only" as Visibility },
      { id: "2", visibility: "student" as Visibility },
    ],
    dailyValues: [
      { id: "10", itemDefinitionId: "1" },
      { id: "11", itemDefinitionId: "2" },
      { id: "12", itemDefinitionId: "3" },
    ],
    dutyAssignments: [{ id: "20" }],
    conflicts: [{ assignmentId: "20" }],
    dutyChanges: [{ id: "30" }],
    dayRecords: [] as string[],
  };
}

describe("audienceRankOf", () => {
  it("unknown audiences fail closed (most open audience, not staff)", () => {
    expect(audienceRankOf("staff")).toBe(0);
    expect(audienceRankOf("student")).toBe(2);
    expect(audienceRankOf("typo")).toBe(3);
  });

  it("viewAudienceRank is the 4.5 effective rank of the view's audience", () => {
    expect(viewAudienceRank("staff")).toBe(0);
    expect(viewAudienceRank("guardian")).toBe(1);
    expect(viewAudienceRank("student")).toBe(2);
    expect(viewAudienceRank("public")).toBe(3);
  });
});

describe("student view whitelist", () => {
  const rank = audienceRankOf("student");
  const cols = audienceColumns(columns, items, rank);
  const allowed = audienceItems(items, cols, rank);

  it("only student-visible item columns, no duty columns", () => {
    expect(cols.map((c) => c.label)).toEqual(["行事", "給食"]);
    expect(allowed.map((i) => i.id)).toEqual(["1"]);
  });

  it("items not listed as columns stay hidden even if visible", () => {
    const onlyEvents = audienceColumns([columns[0] as (typeof columns)[number]], items, rank);
    expect(audienceItems(items, onlyEvents, rank)).toEqual([]);
  });

  it("range keeps only reachable events and allowed values; duty data is dropped", () => {
    const r = filterRangeForAudience(range(), new Set(allowed.map((i) => i.id)), rank);
    expect(r.events.map((e) => e.id)).toEqual(["2"]);
    expect(r.dailyValues.map((d) => d.id)).toEqual(["10"]);
    expect(r.dutyAssignments).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.dutyChanges).toEqual([]);
    // Fields the filter does not own pass through untouched.
    expect(r.dayRecords).toEqual([]);
  });
});

describe("staff view", () => {
  it("sees everything unchanged", () => {
    const r0 = range();
    expect(filterRangeForAudience(r0, new Set(), 0)).toBe(r0);
    expect(audienceItems(items, [], 0)).toEqual(items);
  });
});

describe("targetRangeLabel", () => {
  it("numeric targets collapse into a range", () => {
    expect(targetRangeLabel(["1年", "2年", "3年", "4年", "5年", "6年"])).toBe("1～6年");
    expect(targetRangeLabel(["3年"])).toBe("3年");
  });
  it("non-numeric targets are listed, not ranged (DESIGN 4.8.2)", () => {
    expect(targetRangeLabel(["小学部", "中学部", "高等部"])).toBe("小学部・中学部・高等部");
  });
});

describe("groupSameValues (DESIGN 4.8.2)", () => {
  const grades = ["1年", "2年", "3年", "4年", "5年", "6年"];
  const withValues = (values: (string | null)[]) =>
    grades.map((name, i) => ({ name, value: values[i] ?? null }));

  it("all targets the same: shown once, as a range", () => {
    const entries = withValues(Array(6).fill("14:30～14:40"));
    expect(formatGroupedValues(entries)).toBe("1～6年 14:30～14:40");
  });

  it("a leading run and a trailing pair: 1～4年 …／5・6年 …", () => {
    const entries = withValues([
      "14:30～14:40",
      "14:30～14:40",
      "14:30～14:40",
      "14:30～14:40",
      "15:20～15:30",
      "15:20～15:30",
    ]);
    expect(formatGroupedValues(entries)).toBe("1～4年 14:30～14:40／5・6年 15:20～15:30");
    expect(groupSameValues(entries).map((g) => g.names)).toEqual([
      ["1年", "2年", "3年", "4年"],
      ["5年", "6年"],
    ]);
  });

  it("non-consecutive targets with the same value are enumerated: 1・3年", () => {
    const entries = [
      { name: "1年", value: "14:30" },
      { name: "3年", value: "14:30" },
    ];
    expect(formatGroupedValues(entries)).toBe("1・3年 14:30");
  });

  it("changing only 3年 splits the block in three: 1・2年／3年／4～6年", () => {
    const entries = withValues([
      "14:30～14:40",
      "14:30～14:40",
      "15:20～15:30",
      "14:30～14:40",
      "14:30～14:40",
      "14:30～14:40",
    ]);
    expect(formatGroupedValues(entries)).toBe(
      "1・2年 14:30～14:40／3年 15:20～15:30／4～6年 14:30～14:40",
    );
  });

  it("all targets different: each is shown on its own", () => {
    const entries = withValues(["13:30", "14:00", "14:30", "15:00", "15:30", "16:00"]);
    expect(groupSameValues(entries)).toHaveLength(6);
    expect(formatGroupedValues(entries)).toBe(
      "1年 13:30／2年 14:00／3年 14:30／4年 15:00／5年 15:30／6年 16:00",
    );
  });

  it("non-numeric targets are enumerated only, never ranged", () => {
    const entries = [
      { name: "小学部", value: "14:30" },
      { name: "中学部", value: "14:30" },
      { name: "高等部", value: "15:30" },
    ];
    expect(formatGroupedValues(entries)).toBe("小学部・中学部 14:30／高等部 15:30");
  });

  it("targets without a value take no part in the display", () => {
    const entries = withValues(["14:30", null, "14:30", null, null, null]);
    expect(formatGroupedValues(entries)).toBe("1・3年 14:30");
    expect(formatGroupedValues(withValues(Array(6).fill(null)))).toBe("");
  });

  it("groupSameValues false keeps every target separate (per-target columns)", () => {
    const entries = withValues(Array(6).fill("14:30"));
    expect(groupSameValues(entries, { groupSameValues: false })).toHaveLength(6);
    expect(formatGroupedValues(entries, { groupSameValues: false })).toBe(
      "1年 14:30／2年 14:30／3年 14:30／4年 14:30／5年 14:30／6年 14:30",
    );
  });
});
