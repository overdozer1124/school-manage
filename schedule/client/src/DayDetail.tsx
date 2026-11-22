import { useEffect, useId, useRef } from "react";
import type { CellEditorContext } from "./cells";
import { columnLabel, dayLabel, dayMark, weekdayLabel } from "./lib";
import { TableBodyCell, useCellActivation } from "./RowsTable";
import { useDialogFocus } from "./useDialogFocus";
import type { BootstrapData, RangeData, RangeDayData } from "./types";

/**
 * One day's detail (Issue #43; DESIGN schedule 4.8.1): what a
 * calendar-grid cell's click opens — the day as one row of the
 * rows table, "L2 の1日分相当". The cells are the shared
 * TableBodyCell over the view's columns, so everything the rows
 * do happens here unchanged: entries open the detail modal,
 * daily values show grouped, duties carry their marks. With an
 * editor, the day's entry cell starts active — the grid's input
 * is 「日マスを選んで入力開始」, and selecting the day is what
 * brought the reader here — so typing lands in the entry input
 * at once, and from there the flow is the other layouts': Enter
 * saves, the popover or the modal follows (DESIGN schedule 6).
 * Without an editor (the public screen) the day is read-only.
 */
export function DayDetail({
  bootstrap,
  range,
  day,
  editor,
  onClose,
}: {
  bootstrap: BootstrapData;
  range: RangeData;
  day: RangeDayData;
  editor?: CellEditorContext | undefined;
  onClose(): void;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  const headingId = useId();
  const columns = [...range.view.columns].sort((a, b) => a.sort - b.sort);
  const activation = useCellActivation();
  const mark = dayMark(day, bootstrap.masters.dayPatterns);

  // Input starts on the entry column: the event category when
  // the view carries one, else its first daily-item column (an
  // event_list item column is an entry cell too). The ref keeps
  // the activation to the opening — later activations are the
  // reader's own clicks.
  const entryColumn =
    columns.find((c) => c.sourceKind === "event_category") ??
    columns.find((c) => c.sourceKind === "daily_item");
  const activatedRef = useRef(false);
  useEffect(() => {
    if (!editor || !entryColumn || activatedRef.current) return;
    activatedRef.current = true;
    activation.cellProps(day, entryColumn).onActivate();
  });

  return (
    <div
      className="duty-panel-overlay"
      onClick={(e) => {
        // The dialog lives inside a grid cell whose click opens
        // it: a click inside must not fall through to the cell
        // behind, and a click on the shade itself closes.
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="duty-panel day-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        <div className="duty-panel-head">
          <h2 id={headingId}>{dayLabel(day.date)} の詳細</h2>
          <button type="button" onClick={onClose}>
            閉じる
          </button>
        </div>
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
              <tr data-date={day.date} className={mark.closed ? "closed" : undefined}>
                <th scope="row" className={`date-cell kind-${mark.kind || "plain"}`}>
                  <span className="date-num">{Number(day.date.slice(8, 10))}</span>
                  <span className="date-weekday">（{weekdayLabel(day.date)}）</span>
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
                    {...activation.cellProps(day, column)}
                  />
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
