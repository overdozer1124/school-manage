import { useState } from "react";
import { columnLabel } from "../lib";
import type { BootstrapData, ViewColumnData, ViewDefinitionData } from "../types";
import {
  AUDIENCE_LABELS,
  LAYOUT_LABELS,
  PERIOD_SCOPE_LABELS,
  newRowId,
  Section,
  type SectionCtx,
} from "./shared";

/** Views: their columns (add / remove / reorder), audience,
 *  layout, and a header preview of the columns as the table
 *  will head them. */
export function ViewsSection({ ctx }: { ctx: SectionCtx }) {
  const { views, setViews, api, run, busy, deleteButton, bootstrap, defs } = ctx;
  const items = defs?.itemDefinitions ?? [];
  const [form, setForm] = useState<{
    id: string | null;
    name: string;
    layout: string;
    audience: string;
    periodScope: string;
    layoutParams: Record<string, unknown> | null;
    printSettings: Record<string, unknown> | null;
    columns: ViewColumnData[];
  } | null>(null);
  const [addKind, setAddKind] = useState("daily_item");
  const [addRef, setAddRef] = useState("");

  const openForm = (view: ViewDefinitionData | null) => {
    setForm({
      id: view?.id ?? null,
      name: view?.name ?? "",
      layout: view?.layout ?? "month_rows",
      audience: view?.audience ?? "staff",
      periodScope: view?.periodScope ?? "month",
      layoutParams: view?.layoutParams ?? null,
      printSettings: view?.printSettings ?? null,
      columns: view ? structuredClone(view.columns) : [],
    });
    setAddRef("");
  };

  const previewBootstrap: BootstrapData = {
    ...bootstrap,
    itemDefinitions: items,
    dutyDefinitions: ctx.duties,
  };

  return (
    <Section title="ビュー（表示の定義）">
      <ul className="settings-list">
        {views.map((view) => (
          <li key={view.id}>
            <span>
              {view.name}
              <span className="dim">
                （{LAYOUT_LABELS[view.layout] ?? view.layout}／
                {AUDIENCE_LABELS[view.audience] ?? view.audience}／
                {PERIOD_SCOPE_LABELS[view.periodScope] ?? view.periodScope}／列{view.columns.length}
                件）
              </span>
            </span>{" "}
            <button type="button" disabled={busy} onClick={() => openForm(view)}>
              編集
            </button>{" "}
            {deleteButton(`view:${view.id}`, "削除", async () => {
              await api.deleteViewDefinition({ id: view.id });
              setViews((list) => list.filter((v) => v.id !== view.id));
            })}
          </li>
        ))}
      </ul>
      {form === null && (
        <button type="button" disabled={busy} onClick={() => openForm(null)}>
          ビューを追加
        </button>
      )}
      {form && (
        <div className="settings-form">
          <label>
            ビューの名前{" "}
            <input
              aria-label="ビューの名前"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            レイアウト{" "}
            <select
              aria-label="レイアウト"
              value={form.layout}
              onChange={(e) => setForm({ ...form, layout: e.target.value })}
            >
              {Object.entries(LAYOUT_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            受け手{" "}
            <select
              aria-label="受け手"
              value={form.audience}
              onChange={(e) => setForm({ ...form, audience: e.target.value })}
            >
              {Object.entries(AUDIENCE_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            期間{" "}
            <select
              aria-label="期間"
              value={form.periodScope}
              onChange={(e) => setForm({ ...form, periodScope: e.target.value })}
            >
              {Object.entries(PERIOD_SCOPE_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="settings-checks">
            <legend>列（上から順に左から並びます）</legend>
            {form.columns.map((column, i) => (
              <div key={column.id} className="settings-row">
                <span>{columnLabel(column, previewBootstrap)}</span>
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() =>
                    setForm({
                      ...form,
                      columns: form.columns.map((c, j) =>
                        j === i - 1
                          ? column
                          : j === i
                            ? (form.columns[i - 1] as ViewColumnData)
                            : c,
                      ),
                    })
                  }
                >
                  上へ
                </button>
                <button
                  type="button"
                  disabled={i === form.columns.length - 1}
                  onClick={() =>
                    setForm({
                      ...form,
                      columns: form.columns.map((c, j) =>
                        j === i + 1
                          ? column
                          : j === i
                            ? (form.columns[i + 1] as ViewColumnData)
                            : c,
                      ),
                    })
                  }
                >
                  下へ
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setForm({ ...form, columns: form.columns.filter((_, j) => j !== i) })
                  }
                >
                  列を外す
                </button>
              </div>
            ))}
            <div className="settings-row">
              <select
                aria-label="列の種類"
                value={addKind}
                onChange={(e) => {
                  setAddKind(e.target.value);
                  setAddRef("");
                }}
              >
                <option value="event_category">行事（種別ごとの列）</option>
                <option value="daily_item">項目の列</option>
                <option value="duty">当番の列</option>
                <option value="day_attribute">日の種別</option>
              </select>
              {addKind === "daily_item" && (
                <select
                  aria-label="列にする項目"
                  value={addRef}
                  onChange={(e) => setAddRef(e.target.value)}
                >
                  <option value="">項目を選ぶ</option>
                  {items.map((itemDef) => (
                    <option key={itemDef.id} value={itemDef.id}>
                      {itemDef.name}
                    </option>
                  ))}
                </select>
              )}
              {addKind === "duty" && (
                <select
                  aria-label="列にする当番"
                  value={addRef}
                  onChange={(e) => setAddRef(e.target.value)}
                >
                  <option value="">当番を選ぶ</option>
                  {ctx.duties.map((duty) => (
                    <option key={duty.id} value={duty.id}>
                      {duty.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                disabled={(addKind === "daily_item" || addKind === "duty") && addRef === ""}
                onClick={() => {
                  const viewId = form.id ?? "new-view";
                  setForm({
                    ...form,
                    columns: [
                      ...form.columns,
                      {
                        id: newRowId("col"),
                        viewDefinitionId: viewId,
                        sourceKind: addKind as ViewColumnData["sourceKind"],
                        itemDefinitionId: addKind === "daily_item" ? addRef : null,
                        dutyDefinitionId: addKind === "duty" ? addRef : null,
                        targetGroupId: null,
                        groupSameValues: true,
                        widthHint: null,
                        sort: form.columns.length + 1,
                      },
                    ],
                  });
                  setAddRef("");
                }}
              >
                列を足す
              </button>
            </div>
          </fieldset>
          <div>
            <p className="dim">プレビュー（列の見出し）</p>
            <table className="rows-table settings-preview">
              <thead>
                <tr>
                  <th>日付</th>
                  {form.columns.map((column) => (
                    <th key={column.id}>{columnLabel(column, previewBootstrap)}</th>
                  ))}
                </tr>
              </thead>
            </table>
          </div>
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const saved = await api.upsertViewDefinition({
                      id: form.id ?? newRowId("view"),
                      name: form.name,
                      layout: form.layout,
                      layoutParams: form.layoutParams,
                      audience: form.audience,
                      periodScope: form.periodScope,
                      printSettings: form.printSettings,
                      columns: form.columns.map((c, i) => ({
                        id: c.id,
                        sourceKind: c.sourceKind,
                        itemDefinitionId: c.itemDefinitionId,
                        dutyDefinitionId: c.dutyDefinitionId,
                        targetGroupId: c.targetGroupId,
                        groupSameValues: c.groupSameValues,
                        widthHint: c.widthHint,
                        sort: i + 1,
                      })),
                    });
                    setViews((list) => [...list.filter((v) => v.id !== saved.id), saved]);
                  },
                  () => setForm(null),
                )
              }
            >
              ビューを保存
            </button>
            <button type="button" disabled={busy} onClick={() => setForm(null)}>
              やめる
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}
