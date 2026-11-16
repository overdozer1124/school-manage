import { useState } from "react";
import { DailyCell, EntryCell, isImeKeyEvent, type CellEditorContext } from "./cells";
import {
  columnLabel,
  dailyCellText,
  dayAttributeText,
  dayMark,
  dutyCellLines,
  eventCellLines,
  weekdayLabel,
} from "./lib";
import type { BootstrapData, RangeData, RangeDayData, ViewColumnData } from "./types";

/**
 * The rows table shared by L1 (month_rows) and L2 (week_rows) —
 * ported from the prototype's RowsTable (client/src/App.tsx) for
 * this implementation's getRange shape: one row per day, the view's
 * columns across. Saturdays are blue and Sundays / holidays red,
 * and the weekday letter plus the holiday / day-type name are
 * always printed with the date, so colour is never the only signal
 * (DESIGN schedule 9.1). Duty cells carry the marks of Issue #38:
 * （交代） for an assignment a change was applied to, and a ⚠
 * warning naming the overlap for a conflicted one — again text,
 * not colour alone.
 *
 * With an editor context (Issue #35), entry and daily-value cells
 * are selectable: a click — or a key press on the focused cell —
 * starts input in place, with the typed character seeding the
 * draft, and Enter saves (DESIGN schedule 6.1 / 6.2). Without one
 * the table is the read-only table of Issue #34.
 */
export function RowsTable({
  bootstrap,
  range,
  editor,
}: {
  bootstrap: BootstrapData;
  range: RangeData;
  editor?: CellEditorContext;
}) {
  const columns = [...range.view.columns].sort((a, b) => a.sort - b.sort);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [seed, setSeed] = useState<{ key: string; text: string } | null>(null);

  // Duty cells are lines, not one text (Issue #38): each
  // assignment a line, with the （交代） mark and the ⚠ overlap
  // warning as text next to it.
  const renderDutyCell = (day: RangeDayData, column: ViewColumnData) =>
    dutyCellLines(day, column, bootstrap, range.conflicts).map((line, i) => (
      <div key={line.assignmentId ?? `unassigned-${line.slot}-${i}`}>
        {line.text}
        {line.swapped && (
          <span className="duty-swapped" title="交代済み">
            （交代）
          </span>
        )}
        {line.warning && (
          <span className="duty-warning" title={line.warning}>
            {" "}
            ⚠ {line.warning}
          </span>
        )}
      </div>
    ));

  const renderCell = (day: RangeDayData, column: ViewColumnData) => {
    if (!editor) {
      return (
        <>
          {column.sourceKind === "event_category" &&
            eventCellLines(day).map((line, i) => <div key={i}>{line}</div>)}
          {column.sourceKind === "daily_item" && dailyCellText(day, column, bootstrap)}
          {column.sourceKind === "duty" && renderDutyCell(day, column)}
          {column.sourceKind === "day_attribute" && dayAttributeText(day)}
        </>
      );
    }
    const key = `${day.date}|${column.id}`;
    const cellProps = {
      day,
      column,
      bootstrap,
      editor,
      active: activeKey === key,
      seedText: seed?.key === key ? seed.text : null,
      onActivate: () => setActiveKey(key),
    };
    if (column.sourceKind === "event_category") return <EntryCell {...cellProps} />;
    if (column.sourceKind === "daily_item") {
      const item = bootstrap.itemDefinitions.find((i) => i.id === column.itemDefinitionId);
      return item?.valueType === "event_list" ? (
        <EntryCell {...cellProps} />
      ) : (
        <DailyCell {...cellProps} />
      );
    }
    if (column.sourceKind === "duty") return <>{renderDutyCell(day, column)}</>;
    return <>{dayAttributeText(day)}</>;
  };
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
                {columns.map((column) => {
                  const key = `${day.date}|${column.id}`;
                  const editable =
                    editor !== undefined &&
                    (column.sourceKind === "event_category" || column.sourceKind === "daily_item");
                  return (
                    <td
                      key={column.id}
                      className={editable && activeKey === key ? "cell-active" : undefined}
                      tabIndex={editable ? 0 : undefined}
                      onClick={editable ? () => setActiveKey(key) : undefined}
                      onKeyDown={
                        editable
                          ? (e) => {
                              if (
                                e.target !== e.currentTarget ||
                                activeKey === key ||
                                e.ctrlKey ||
                                e.metaKey ||
                                e.altKey
                              ) {
                                return;
                              }
                              // An IME keystroke opens the cell
                              // without seeding: the romaji would
                              // otherwise stick as the draft's
                              // first character while the rest
                              // converts in the input, which takes
                              // focus as it opens (PR #75 review).
                              if (isImeKeyEvent(e)) {
                                setActiveKey(key);
                                return;
                              }
                              // Typing on the focused cell starts
                              // input with that character (6.1).
                              if (e.key.length === 1) {
                                setActiveKey(key);
                                setSeed({ key, text: e.key });
                              }
                            }
                          : undefined
                      }
                    >
                      {renderCell(day, column)}
                    </td>
                  );
                })}
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
