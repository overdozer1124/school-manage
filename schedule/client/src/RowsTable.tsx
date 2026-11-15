import {
  columnLabel,
  dailyCellText,
  dayAttributeText,
  dayMark,
  dutyCellText,
  eventCellLines,
  weekdayLabel,
} from "./lib";
import type { BootstrapData, RangeData } from "./types";

/**
 * The rows table shared by L1 (month_rows) and L2 (week_rows) —
 * ported from the prototype's RowsTable (client/src/App.tsx) and
 * rewritten read-only for this implementation's getRange shape:
 * one row per day, the view's columns across, input left to the
 * following issues. Saturdays are blue and Sundays / holidays red,
 * and the weekday letter plus the holiday / day-type name are
 * always printed with the date, so colour is never the only signal
 * (DESIGN schedule 9.1).
 */
export function RowsTable({ bootstrap, range }: { bootstrap: BootstrapData; range: RangeData }) {
  const columns = [...range.view.columns].sort((a, b) => a.sort - b.sort);
  return (
    <div className="rows-table-wrap">
      <table className="rows-table">
        <thead>
          <tr>
            <th scope="col" className="date-col">
              日
            </th>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                style={column.widthHint ? { width: column.widthHint } : undefined}
              >
                {columnLabel(column, bootstrap)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {range.days.map((day) => {
            const mark = dayMark(day, bootstrap.masters.dayPatterns);
            return (
              <tr
                key={day.date}
                data-date={day.date}
                className={mark.closed ? "closed" : undefined}
              >
                <th scope="row" className={`date-cell kind-${mark.kind || "plain"}`}>
                  <span className="date-num">{Number(day.date.slice(8, 10))}</span>
                  <span className="date-weekday">（{weekdayLabel(day.date)}）</span>
                  {mark.sub && <span className="date-sub">{mark.sub}</span>}
                </th>
                {columns.map((column) => (
                  <td key={column.id}>
                    {column.sourceKind === "event_category" &&
                      eventCellLines(day).map((line, i) => <div key={i}>{line}</div>)}
                    {column.sourceKind === "daily_item" && dailyCellText(day, column, bootstrap)}
                    {column.sourceKind === "duty" && dutyCellText(day, column, bootstrap)}
                    {column.sourceKind === "day_attribute" && dayAttributeText(day)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The month's undecided section (DESIGN schedule 5.2 scenario 9):
 *  month-precision and fully undecided events, apart from the days. */
export function UndecidedSection({ events }: { events: Record<string, unknown>[] }) {
  return (
    <section className="undecided" aria-label="その月の未定">
      <h2>その月の未定</h2>
      {events.length === 0 ? (
        <p className="undecided-empty">未定の予定はありません。</p>
      ) : (
        <ul>
          {events.map((event, i) => (
            <li key={typeof event["id"] === "string" ? (event["id"] as string) : i}>
              <span className="undecided-title">
                {typeof event["title"] === "string" ? (event["title"] as string) : "（無題）"}
              </span>
              <span className="undecided-kind">
                {event["datePrecision"] === "undecided" ? "時期未定" : "月のみ確定"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
