import { useState } from "react";
import { DailyCell, EntryCell, isImeKeyEvent, type CellEditorContext } from "./cells";
import type { EventDragContext } from "./drag";
import {
  columnLabel,
  dailyCellText,
  dayAttributeText,
  dayMark,
  dutyCellLines,
  eventCellLines,
  weekdayLabel,
} from "./lib";
import type {
  BootstrapData,
  DutyConflictData,
  RangeData,
  RangeDayData,
  ViewColumnData,
} from "./types";

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
 *
 * The cell itself (TableBodyCell below) is shared with the L3
 * year table (Issue #42): a cell is a day × a view column in
 * every rows layout, so its display and its input behave the
 * same wherever the day sits.
 */
export function RowsTable({
  bootstrap,
  range,
  editor,
  drag,
}: {
  bootstrap: BootstrapData;
  range: RangeData;
  editor?: CellEditorContext;
  /** Drag & drop moving (Issue #50): the day rows are drop
   *  targets, and their event lines are grabbable. */
  drag?: EventDragContext;
}) {
  const columns = [...range.view.columns].sort((a, b) => a.sort - b.sort);
  const activation = useCellActivation();

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
                {...(drag ? drag.dropTargetProps(day.date) : {})}
                className={mark.closed ? "closed" : undefined}
              >
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
                    drag={drag}
                    {...activation.cellProps(day, column)}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Which cell of a table is being edited, and the character typed
 * on the cell itself that seeds its draft (Issue #35). One table
 * holds one activation: starting input in another cell moves it.
 */
export function useCellActivation() {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [seed, setSeed] = useState<{ key: string; text: string } | null>(null);
  return {
    cellProps(day: RangeDayData, column: ViewColumnData) {
      const key = `${day.date}|${column.id}`;
      return {
        active: activeKey === key,
        seedText: seed?.key === key ? seed.text : null,
        onActivate: () => setActiveKey(key),
        onSeed: (text: string) => {
          setActiveKey(key);
          setSeed({ key, text });
        },
      };
    },
  };
}

/**
 * One body cell: a day × a view column. Entry and daily-value
 * columns are editable when the table carries an editor context
 * (the cell takes focus, a click or a typed character starts
 * input in place); duty and day-attribute columns only ever
 * display, as do all columns of a read-only table. A column the
 * view does not carry never reaches this component at all — the
 * tables build their cells from the view's columns alone — so
 * input exists only on displayed columns (DESIGN schedule
 * 4.8.1, the L3 rule, true of every layout by construction).
 */
export function TableBodyCell({
  day,
  column,
  bootstrap,
  conflicts,
  editor,
  drag,
  active,
  seedText,
  onActivate,
  onSeed,
}: {
  day: RangeDayData;
  column: ViewColumnData;
  bootstrap: BootstrapData;
  conflicts: DutyConflictData[];
  /** The table's editor context, or undefined for a read-only
   *  table (declared as a plain union, not an optional prop:
   *  the tables always pass it, undefined included). */
  editor: CellEditorContext | undefined;
  /** The table's drag context (Issue #50), or undefined when
   *  the table does not carry drag & drop moving. */
  drag: EventDragContext | undefined;
  active: boolean;
  seedText: string | null;
  onActivate(): void;
  onSeed(text: string): void;
}) {
  // Duty cells are lines, not one text (Issue #38): each
  // assignment a line, with the （交代） mark and the ⚠ overlap
  // warning as text next to it.
  const renderDutyCell = () =>
    dutyCellLines(day, column, bootstrap, conflicts).map((line, i) => (
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

  const renderCell = () => {
    if (!editor) {
      return (
        <>
          {column.sourceKind === "event_category" &&
            eventCellLines(day).map((line, i) => <div key={i}>{line}</div>)}
          {column.sourceKind === "daily_item" && dailyCellText(day, column, bootstrap)}
          {column.sourceKind === "duty" && renderDutyCell()}
          {column.sourceKind === "day_attribute" && dayAttributeText(day)}
        </>
      );
    }
    const cellProps = {
      day,
      column,
      bootstrap,
      editor,
      drag,
      active,
      seedText,
      onActivate,
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
    if (column.sourceKind === "duty") return <>{renderDutyCell()}</>;
    return <>{dayAttributeText(day)}</>;
  };

  const editable =
    editor !== undefined &&
    (column.sourceKind === "event_category" || column.sourceKind === "daily_item");
  // A drag & drop drop target (Issue #50): the cell names its
  // day for the drag's hit-testing, and highlights while a drag
  // hovers its day — every cell of the day lights together, so
  // the target reads as the day, not as one column.
  const dropTarget = drag !== undefined && drag.dropDate === day.date;
  const classNames = [editable && active ? "cell-active" : "", dropTarget ? "drop-target" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <td
      className={classNames === "" ? undefined : classNames}
      {...(drag ? drag.dropTargetProps(day.date) : {})}
      tabIndex={editable ? 0 : undefined}
      onClick={editable ? onActivate : undefined}
      onKeyDown={
        editable
          ? (e) => {
              if (e.target !== e.currentTarget || active || e.ctrlKey || e.metaKey || e.altKey) {
                return;
              }
              // An IME keystroke opens the cell without seeding:
              // the romaji would otherwise stick as the draft's
              // first character while the rest converts in the
              // input, which takes focus as it opens (PR #75
              // review).
              if (isImeKeyEvent(e)) {
                onActivate();
                return;
              }
              // Typing on the focused cell starts input with
              // that character (6.1).
              if (e.key.length === 1) {
                onSeed(e.key);
              }
            }
          : undefined
      }
    >
      {renderCell()}
    </td>
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
