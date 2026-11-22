import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DailyCell, isImeKeyEvent, type CellEditorContext } from "./cells";
import { DetailModal, type DetailTarget } from "./DetailModal";
import {
  dailyValueForTarget,
  dailyValueText,
  dayMark,
  eventTargetIds,
  eventTimeText,
  eventTitle,
  plainDailyValue,
  provisionalTemplateOf,
  templateForKind,
  transposedModel,
  weekdayLabel,
} from "./lib";
import type {
  BootstrapData,
  ItemDefinitionData,
  RangeData,
  RangeDayData,
  ViewColumnData,
} from "./types";

/**
 * The transposed table (Issue #45; DESIGN schedule 4.8,
 * 5.2 scenario 5): rows are the members of the view's target
 * axis — the clubs of a junior-high school, in the scenario —
 * and columns are the days of the view's period scope (lib's
 * transposedRange). Each cell is that target's daily value for
 * the day, drawn and edited through the shared DailyCell in its
 * one-target slice: the value written here is the same
 * per-target DailyValue the L1 table groups into one cell
 * (4.8.2), so the two tables read and write one datum, never a
 * copy. An event that names the row's target as one of its
 * targets stands in the cell under the values, and opens its
 * detail modal on a click, as in every layout.
 *
 * A value of a shown item that carries no target stands in a
 * （対象指定なし） row of its own, as the prototype drew it, so
 * a whole-school value typed against a per-target item is
 * never invisible. A view whose daily items range over no
 * axis has no rows to draw: the table says what it needs
 * instead of standing empty.
 *
 * Without an editor (the public screen) the table is
 * read-only, as in L3–L5.
 */
export function TransposedTable({
  bootstrap,
  range,
  editor,
}: {
  bootstrap: BootstrapData;
  range: RangeData;
  editor?: CellEditorContext;
}) {
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [seed, setSeed] = useState<{ key: string; text: string } | null>(null);

  const columns = [...range.view.columns].sort((a, b) => a.sort - b.sort);
  const model = transposedModel(bootstrap, columns);

  if (!model) {
    return (
      <p className="transposed-notice">
        転置表には、対象軸（学年・部活動など）を持つ日次項目の列が必要です。ビューの列に、下校時刻や部活動のような対象別項目を入れてください。
      </p>
    );
  }
  if (model.entries.length === 0) {
    return (
      <p className="transposed-notice">
        「{model.axisLabel}」の対象がまだ登録されていません。設定画面の「対象軸」で
        {model.axisLabel}の対象（部活動なら各部）を追加すると、行として並びます。
      </p>
    );
  }

  const hasLooseValues = range.days.some((day) =>
    model.shown.some(({ item }) => plainDailyValue(day, item) !== undefined),
  );
  const rows: { targetId: string | null; name: string }[] = [
    ...model.entries.map((e) => ({ targetId: e.id as string | null, name: e.name })),
    ...(hasLooseValues ? [{ targetId: null, name: "（対象指定なし）" }] : []),
  ];

  const openEventDetail = (event: Record<string, unknown>, day: RangeDayData) => {
    const resolved =
      provisionalTemplateOf(event, bootstrap) ??
      templateForKind(bootstrap, "event", stringField(event, "kind") ?? "") ??
      bootstrap.kindTemplates.find((t) => t.subjectKind === "event") ??
      null;
    if (!resolved) return;
    const scheduleId = day.day["dayScheduleId"];
    setDetail({
      subjectKind: "event",
      template: resolved,
      record: event,
      date: day.date,
      dayScheduleId: typeof scheduleId === "string" ? scheduleId : null,
    });
  };

  const cellShell = (
    day: RangeDayData,
    column: ViewColumnData,
    targetId: string | null,
    item: ItemDefinitionData,
  ) => {
    const key = `${day.date}|${column.id}|${targetId ?? ""}`;
    const active = activeKey === key;
    const editable = editor !== undefined && item.valueType !== "event_list";
    const value =
      targetId === null ? plainDailyValue(day, item) : dailyValueForTarget(day, item, targetId);
    return (
      <div
        key={column.id}
        className={`transposed-cell${editable && active ? " cell-active" : ""}`}
        data-date={day.date}
        data-target={targetId ?? ""}
        tabIndex={editable ? 0 : undefined}
        onClick={
          editable
            ? () => {
                setActiveKey(key);
              }
            : undefined
        }
        onKeyDown={
          editable
            ? (e: ReactKeyboardEvent) => {
                if (e.target !== e.currentTarget || active || e.ctrlKey || e.metaKey || e.altKey) {
                  return;
                }
                if (isImeKeyEvent(e)) {
                  setActiveKey(key);
                  return;
                }
                if (e.key.length === 1) {
                  setActiveKey(key);
                  setSeed({ key, text: e.key });
                }
              }
            : undefined
        }
      >
        {model.shown.length > 1 && <span className="transposed-item-name">{item.name}</span>}
        {editor && editable ? (
          <DailyCell
            day={day}
            column={column}
            bootstrap={bootstrap}
            editor={editor}
            active={active}
            seedText={seed?.key === key ? seed.text : null}
            onActivate={() => setActiveKey(key)}
            targetId={targetId}
          />
        ) : (
          <>{value ? dailyValueText(value, item) : ""}</>
        )}
      </div>
    );
  };

  return (
    <div className="rows-table-wrap transposed-wrap">
      <table className="rows-table transposed-table">
        <thead>
          <tr>
            <th scope="col" className="target-col">
              {model.axisLabel}
            </th>
            {range.days.map((day) => {
              const mark = dayMark(day, bootstrap.masters.dayPatterns);
              return (
                <th
                  key={day.date}
                  scope="col"
                  data-date={day.date}
                  className={`day-col kind-${mark.kind || "plain"}${mark.closed ? " closed" : ""}`}
                >
                  <span className="date-num">{Number(day.date.slice(8, 10))}</span>
                  <span className="date-weekday">（{weekdayLabel(day.date)}）</span>
                  {mark.sub && <span className="date-sub">{mark.sub}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.targetId ?? "none"} data-target={row.targetId ?? ""}>
              <th scope="row" className="target-cell">
                {row.name}
              </th>
              {range.days.map((day) => {
                const targetEvents =
                  row.targetId !== null
                    ? day.events.filter((e) => eventTargetIds(e).includes(row.targetId as string))
                    : [];
                return (
                  <td key={day.date}>
                    {model.shown.map(({ column, item }) =>
                      cellShell(day, column, row.targetId, item),
                    )}
                    {targetEvents.map((event) => {
                      const text = `${eventTimeText(event)}${eventTitle(event)}`;
                      const id = stringField(event, "id") ?? text;
                      return editor && typeof event["revision"] === "number" ? (
                        <button
                          key={id}
                          type="button"
                          className="transposed-event"
                          onClick={() => openEventDetail(event, day)}
                        >
                          {text}
                        </button>
                      ) : (
                        <span key={id} className="transposed-event">
                          {text}
                        </span>
                      );
                    })}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {model.others.length > 0 && (
        <p className="transposed-note">
          ※ {model.others.map((i) => i.name).join("、")} は、この転置表の対象軸（
          {model.axisLabel}）の項目ではないため表示していません。
        </p>
      )}
      {detail && editor && (
        <DetailModal
          target={detail}
          bootstrap={bootstrap}
          api={editor.api}
          onSaved={editor.onSaved}
          onUnauthorizedError={editor.onUnauthorizedError}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}
