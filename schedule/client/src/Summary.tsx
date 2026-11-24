import type {
  SummaryData,
  SummaryItemCountData,
  SummaryMonthData,
  SummaryPeriodData,
} from "./types";

/**
 * The summary displays (Issue #47; DESIGN schedule 8): the
 * derived counts — school days from the days' types, an
 * aggregatable item's days from its values' symbols — that the
 * server counts on every read (getSummary) and stores nowhere.
 * A month table foots itself with the month's section; the year
 * table is followed by the year's table, a row per month and a
 * total row. The public screen never shows these: getSummary
 * is a staff action (view.read), so they belong to the signed-in
 * app only.
 *
 * The day-type labels here name every type the summary counts.
 * The tables' own label map (lib.ts) leaves a class day blank —
 * it is a table's unmarked default — which would read as a
 * missing label in a count list, so this file keeps its own.
 */
const SUMMARY_DAY_TYPE_LABELS: Record<string, string> = {
  class_day: "授業日",
  event_day: "行事日",
  attendance_day: "登校日",
  closed_day: "休業日",
  long_vacation: "長期休業",
};

function dayTypeLabel(code: string): string {
  return SUMMARY_DAY_TYPE_LABELS[code] ?? code;
}

/** 「2026年11月」 for a "2026-11" bucket key. */
function monthHeading(month: string): string {
  const [year, m] = month.split("-");
  return `${year}年${Number(m)}月`;
}

/** The per-target breakdown is worth its line when the item
 *  actually splits — more than one target, or any named target;
 *  an item counted only as a whole reads as its total alone. */
function showsBreakdown(item: SummaryItemCountData): boolean {
  return item.byTarget.length > 1 || item.byTarget.some((t) => t.targetId !== null);
}

function itemLine(item: SummaryItemCountData) {
  return (
    <li key={item.itemId}>
      <span className="summary-item-name">{item.name}</span> {item.total}日
      {showsBreakdown(item) && (
        <span className="summary-breakdown">
          （{item.byTarget.map((t) => `${t.targetName} ${t.count}日`).join("、")}）
        </span>
      )}
    </li>
  );
}

/** One month's counts, footing a month table: the school days,
 *  the other day types that occurred, and each counted item's
 *  days with its per-target breakdown. */
export function SummarySection({ period }: { period: SummaryPeriodData }) {
  const otherTypes = period.dayTypeCounts.filter((c) => c.dayType !== "class_day" && c.count > 0);
  return (
    <section className="summary" aria-label="集計">
      <h2>集計</h2>
      <dl className="summary-counts">
        <div>
          <dt>授業日数</dt>
          <dd>{period.schoolDays}日</dd>
        </div>
        {otherTypes.map((c) => (
          <div key={c.dayType}>
            <dt>{dayTypeLabel(c.dayType)}</dt>
            <dd>{c.count}日</dd>
          </div>
        ))}
      </dl>
      {period.items.length > 0 && <ul className="summary-items">{period.items.map(itemLine)}</ul>}
    </section>
  );
}

function monthItemTotal(month: SummaryMonthData, itemId: string): number {
  return month.items.find((i) => i.itemId === itemId)?.total ?? 0;
}

/** The year's counts under the year table: a row per month —
 *  school days and each counted item's days — and the total
 *  row the server derived over the whole year. */
export function SummaryTable({ summary }: { summary: SummaryData }) {
  const items = summary.total.items;
  return (
    <section className="summary" aria-label="年間の集計">
      <h2>年間の集計</h2>
      <table className="summary-table">
        <thead>
          <tr>
            <th scope="col">月</th>
            <th scope="col">授業日数</th>
            {items.map((item) => (
              <th key={item.itemId} scope="col">
                {item.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {summary.months.map((month) => (
            <tr key={month.month}>
              <th scope="row">{monthHeading(month.month)}</th>
              <td>{month.schoolDays}日</td>
              {items.map((item) => (
                <td key={item.itemId}>{monthItemTotal(month, item.itemId)}日</td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">合計</th>
            <td>{summary.total.schoolDays}日</td>
            {items.map((item) => (
              <td key={item.itemId}>{item.total}日</td>
            ))}
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

/** The note shown when the summary read failed: the table it
 *  foots stays on screen (App keeps it), only the counts are
 *  missing, and the note says so with the read's own message. */
export function SummaryFailure({ message }: { message: string }) {
  return <p className="summary-error">集計を表示できませんでした：{message}</p>;
}
