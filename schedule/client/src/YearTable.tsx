import { Fragment } from "react";
import type { CellEditorContext } from "./cells";
import type { EventDragContext } from "./drag";
import { columnLabel, dayMark, schoolYearMonths, schoolYearOf, weekdayLabel } from "./lib";
import { TableBodyCell, useCellActivation } from "./RowsTable";
import type { BootstrapData, RangeData } from "./types";

/**
 * The L3 year table (year_columns, Issue #42; DESIGN schedule
 * 4.8.1): the L1 rows table laid down twelve times side by side —
 * one block per month, April to March — so a whole school year
 * is read at a glance. The twelve blocks share ONE table: the
 * rows are the days of the month (1–31) for every block alike,
 * so the same day of the month lines up across the year by
 * construction, and a date a month does not have (February 30,
 * April 31, February 29 in a year without one) is an empty cell
 * — no date header, no body cell, and nothing to type into.
 *
 * Each block's columns are the view's own columns, exactly as
 * L1/L2 draw them (the design expects an L3 view to carry a
 * narrowed set, e.g. events only, or events and lunch). Cells
 * are the shared TableBodyCell, so display and direct input
 * behave as in the month table; input exists only on columns
 * the view displays, because cells are built from the view's
 * columns alone. The table is wider than any screen: the
 * wrapper scrolls sideways, as the design intends.
 *
 * The range is the whole school year (lib's rangeFor), and it
 * holds one day per real date — a date missing from it is a
 * date that does not exist, which is what makes the empty
 * cells above a lookup rather than a calendar computation.
 */
export function YearTable({
  bootstrap,
  range,
  editor,
  drag,
}: {
  bootstrap: BootstrapData;
  range: RangeData;
  editor?: CellEditorContext;
  /** Drag & drop moving (Issue #50): the shared cells carry
   *  it, so the year table moves events the rows tables' way. */
  drag?: EventDragContext;
}) {
  const columns = [...range.view.columns].sort((a, b) => a.sort - b.sort);
  const activation = useCellActivation();
  const byDate = new Map(range.days.map((day) => [day.date, day]));
  const months = schoolYearMonths(schoolYearOf(range.from));
  const dayNumbers = Array.from({ length: 31 }, (_, i) => i + 1);

  return (
    <div className="rows-table-wrap year-table-wrap">
      <table className="rows-table year-table">
        <thead>
          <tr>
            {months.map(({ year, month }) => (
              <th
                key={`${year}-${month}`}
                scope="col"
                colSpan={columns.length + 1}
                className="year-month-head"
              >
                {month}月
              </th>
            ))}
          </tr>
          <tr>
            {months.map(({ year, month }) => (
              <Fragment key={`${year}-${month}`}>
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
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {dayNumbers.map((dayNum) => (
            <tr key={dayNum} data-day={dayNum}>
              {months.map(({ year, month }) => {
                const date = `${year}-${String(month).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
                const day = byDate.get(date);
                if (!day) {
                  // A date this month does not have: the row
                  // still stands (the days line up across the
                  // year), with every cell of the block empty.
                  return (
                    <Fragment key={`${year}-${month}`}>
                      <th scope="row" className="date-cell no-date" />
                      {columns.map((column) => (
                        <td key={column.id} className="no-date" />
                      ))}
                    </Fragment>
                  );
                }
                const mark = dayMark(day, bootstrap.masters.dayPatterns);
                return (
                  <Fragment key={`${year}-${month}`}>
                    <th
                      scope="row"
                      data-date={date}
                      {...(drag ? drag.dropTargetProps(date) : {})}
                      className={`date-cell kind-${mark.kind || "plain"}${mark.closed ? " closed" : ""}`}
                    >
                      <span className="date-num">{dayNum}</span>
                      <span className="date-weekday">（{weekdayLabel(date)}）</span>
                      {mark.sub && <span className="date-sub">{mark.sub}</span>}
                    </th>
                    {columns.map((column) => (
                      <TableBodyCell
                        key={column.id}
                        day={day}
                        column={column}
                        bootstrap={bootstrap}
                        conflicts={range.conflicts}
                        editor={editor}
                        drag={drag}
                        {...activation.cellProps(day, column)}
                      />
                    ))}
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
