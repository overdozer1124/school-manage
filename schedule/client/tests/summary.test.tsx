import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { datesInRange, weekdayOf } from "@school-manage/calendar-types";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { createDevApi } from "../src/devAdapter";

afterEach(cleanup);

// Summary tests (Issue #47; DESIGN schedule 8): the counts at
// the foot of a month table and in the year's summary table are
// derived from the days' types and the daily values' symbols —
// the dev fixture's November 2026 has 19 class days (21 weekdays
// less the two national holidays), lunch on every class day,
// and two days (19–20 November) where lunch is recorded per
// grade because the sixth years are away on their school trip:
// the other grades eat, the sixth years do not.

describe("the month table's summary", () => {
  it("foots the month with school days and lunch days, the sixth years apart", async () => {
    const api = createDevApi();
    render(<App api={api} initialAnchor="2026-11-16" />);
    await screen.findByText("開発用小学校");

    const section = await screen.findByRole("region", { name: "集計" });
    const inSummary = within(section);
    expect(inSummary.getByText("授業日数")).toBeInTheDocument();
    // The lunch line: 19 days in total, and every grade counts
    // its real lunch days — the unsplit days fill every grade,
    // so the first years stand at 19 too, the sixth years at
    // 17 (the two trip days), and no 全体 line stands beside
    // the grades.
    const lunchLine = inSummary.getByText("給食").closest("li");
    expect(lunchLine?.textContent).toContain("19日");
    expect(lunchLine?.textContent).toContain("1年 19日");
    expect(lunchLine?.textContent).toContain("5年 19日");
    expect(lunchLine?.textContent).toContain("6年 17日");
    expect(lunchLine?.textContent).not.toContain("全体");
    // The month's school days stand in the counts as 19日 too.
    const schoolDays = inSummary.getByText("授業日数").closest("div");
    expect(schoolDays?.textContent).toContain("19日");
  });

  it("the adapter derives the same numbers the section shows", async () => {
    const api = createDevApi();
    const summary = await api.getSummary({
      from: "2026-11-01",
      to: "2026-11-30",
      viewId: "view-month-staff",
    });
    expect(summary.months.map((m) => m.month)).toEqual(["2026-11"]);
    expect(summary.total.schoolDays).toBe(19);
    expect(summary.total.dayTypeCounts).toContainEqual({ dayType: "closed_day", count: 11 });
    const lunch = summary.total.items.find((i) => i.itemId === "item-lunch");
    expect(lunch?.total).toBe(19);
    expect(lunch?.byTarget).toEqual([
      { targetId: "grade:grade-1", targetName: "1年", count: 19 },
      { targetId: "grade:grade-2", targetName: "2年", count: 19 },
      { targetId: "grade:grade-3", targetName: "3年", count: 19 },
      { targetId: "grade:grade-4", targetName: "4年", count: 19 },
      { targetId: "grade:grade-5", targetName: "5年", count: 19 },
      { targetId: "grade:grade-6", targetName: "6年", count: 17 },
    ]);
  });
});

describe("the year table's summary", () => {
  it("tabulates a row per month and a total row", async () => {
    const api = createDevApi();
    render(<App api={api} initialAnchor="2026-11-16" />);
    await screen.findByText("開発用小学校");
    fireEvent.change(screen.getByLabelText("ビュー"), { target: { value: "view-year-staff" } });

    const section = await screen.findByRole("region", { name: "年間の集計" });
    const inSummary = within(section);
    const rows = inSummary.getAllByRole("row");
    // Header, twelve months, and the total row.
    expect(rows).toHaveLength(14);

    const november = inSummary.getByRole("row", { name: /2026年11月/ });
    expect(november.textContent).toContain("19日");

    // April 2026 holds no fixture holiday, so its school days
    // are its weekdays — counted here, not hardcoded.
    const aprilWeekdays = datesInRange("2026-04-01", "2026-04-30").filter((d) => {
      const w = weekdayOf(d);
      return w !== "sat" && w !== "sun";
    }).length;
    const april = inSummary.getByRole("row", { name: /2026年4月/ });
    expect(april.textContent).toContain(`${aprilWeekdays}日`);

    // The total row is the sum of the month rows, for the
    // school days and for lunch alike (lunch runs every class
    // day in the fixture, so the two columns agree).
    const total = inSummary.getByRole("row", { name: /合計/ });
    const monthRows = rows.slice(1, 13);
    const columnSum = (column: number) =>
      monthRows.reduce(
        (acc, row) => acc + Number((row.children[column]?.textContent ?? "0").replace("日", "")),
        0,
      );
    expect(total.children[1]?.textContent).toBe(`${columnSum(1)}日`);
    // The lunch cell of the total row leads with the year's
    // total and carries the per-grade breakdown under it: the
    // first years ate on every lunch day, the sixth years on
    // two fewer (the school trip), and no 全体 stands there.
    const lunchSum = columnSum(2);
    const lunchCell = total.children[2]?.textContent ?? "";
    expect(lunchCell.startsWith(`${lunchSum}日`)).toBe(true);
    expect(lunchCell).toContain(`1年 ${lunchSum}日`);
    expect(lunchCell).toContain(`6年 ${lunchSum - 2}日`);
    expect(lunchCell).not.toContain("全体");
  });

  it("the adapter's year agrees with its months", async () => {
    const api = createDevApi();
    const summary = await api.getSummary({
      from: "2026-04-01",
      to: "2027-03-31",
      viewId: "view-year-staff",
    });
    expect(summary.months).toHaveLength(12);
    const monthSum = summary.months.reduce((acc, m) => acc + m.schoolDays, 0);
    expect(summary.total.schoolDays).toBe(monthSum);
    const lunch = summary.total.items.find((i) => i.itemId === "item-lunch");
    expect(lunch?.total).toBe(summary.total.schoolDays);
    // Over the year the breakdown lists the grades alone (no
    // 全体）: the first years ate on every lunch day, the
    // sixth years on two fewer — November's trip days.
    const lunchTotal = lunch?.total ?? 0;
    expect(lunch?.byTarget).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => ({
        targetId: `grade:grade-${n}`,
        targetName: `${n}年`,
        count: n === 6 ? lunchTotal - 2 : lunchTotal,
      })),
    );
  });
});
