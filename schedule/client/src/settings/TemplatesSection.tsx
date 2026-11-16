import { useState } from "react";
import type { KindTemplateData } from "../types";
import { STEP_KIND_LABELS, newRowId, Section, type SectionCtx } from "./shared";

/** Kind templates: the shape of one kind of entry (Issue #29) —
 *  which platform record it saves as, and the steps the quick
 *  input walks through (Issue #36). */
export function TemplatesSection({ ctx }: { ctx: SectionCtx }) {
  const { templates, setTemplates, api, run, busy, deleteButton, defs, setNotice } = ctx;
  const items = defs?.itemDefinitions ?? [];
  const [form, setForm] = useState<{
    id: string | null;
    key: string;
    name: string;
    subjectKind: "event" | "absence";
    kindCode: string;
    personLabel: string;
    displaySource: string;
    sort: string;
    steps: { kind: string; itemDefinitionId: string | null }[];
    itemDefinitionIds: string[];
  } | null>(null);

  const openForm = (template: KindTemplateData | null) => {
    setForm({
      id: template?.id ?? null,
      key: template?.key ?? "",
      name: template?.name ?? "",
      subjectKind: template?.subjectKind ?? "event",
      kindCode: template?.kindCode ?? "event",
      personLabel: template?.personLabel ?? "担当者",
      displaySource: template?.displaySource ?? "title",
      sort: String(template?.sort ?? templates.length + 1),
      steps: template
        ? template.steps.map((s) => ({
            kind: s.kind,
            itemDefinitionId: s.itemDefinitionId ?? null,
          }))
        : [{ kind: "person", itemDefinitionId: null }],
      itemDefinitionIds: template?.itemDefinitionIds ?? [],
    });
  };

  return (
    <Section title="種別テンプレート">
      <ul className="settings-list">
        {templates.map((template) => (
          <li key={template.id}>
            <span>
              {template.name}
              <span className="dim">
                （{template.key}／{template.subjectKind === "absence" ? "不在" : "行事"}／
                {template.steps.map((s) => STEP_KIND_LABELS[s.kind] ?? s.kind).join("→")}）
              </span>
            </span>{" "}
            <button type="button" disabled={busy} onClick={() => openForm(template)}>
              編集
            </button>{" "}
            {deleteButton(`template:${template.id}`, "削除", async () => {
              await api.deleteKindTemplate({ id: template.id });
              setTemplates((list) => list.filter((t) => t.id !== template.id));
            })}
          </li>
        ))}
      </ul>
      <div className="settings-row">
        {form === null && (
          <button type="button" disabled={busy} onClick={() => openForm(null)}>
            テンプレートを追加
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(
              async () => {
                const applied = (await api.applyDefaultKindTemplates()) as KindTemplateData[];
                if (Array.isArray(applied)) setTemplates(applied);
              },
              () => setNotice("既定の種別テンプレートを適用しました"),
            )
          }
        >
          既定のテンプレートを適用
        </button>
      </div>
      {form && (
        <div className="settings-form">
          <label>
            名前{" "}
            <input
              aria-label="テンプレートの名前"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            キー{" "}
            <input
              aria-label="テンプレートのキー"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
          </label>
          <label>
            保存先{" "}
            <select
              aria-label="保存先"
              value={form.subjectKind}
              onChange={(e) =>
                setForm({
                  ...form,
                  subjectKind: e.target.value as "event" | "absence",
                  kindCode: e.target.value === "absence" ? "business_trip" : "event",
                })
              }
            >
              <option value="event">行事</option>
              <option value="absence">不在（出張・休暇）</option>
            </select>
          </label>
          <label>
            種別コード{" "}
            <select
              aria-label="種別コード"
              value={form.kindCode}
              onChange={(e) => setForm({ ...form, kindCode: e.target.value })}
            >
              {(form.subjectKind === "absence"
                ? [
                    ["business_trip", "出張"],
                    ["training", "研修"],
                    ["leave", "休暇"],
                    ["other", "その他"],
                  ]
                : [
                    ["event", "行事"],
                    ["meeting", "会議"],
                    ["exam", "考査"],
                    ["deadline", "〆切"],
                    ["other", "その他"],
                  ]
              ).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            人の呼び名{" "}
            <input
              aria-label="人の呼び名"
              value={form.personLabel}
              onChange={(e) => setForm({ ...form, personLabel: e.target.value })}
            />
          </label>
          <label>
            セルの表示{" "}
            <select
              aria-label="セルの表示"
              value={form.displaySource}
              onChange={(e) => setForm({ ...form, displaySource: e.target.value })}
            >
              <option value="title">件名で表示</option>
              <option value="person">人で表示</option>
              <option value="person_title">人と件名で表示</option>
            </select>
          </label>
          <fieldset className="settings-checks">
            <legend>ステップ（クイック入力の順）</legend>
            {form.steps.map((step, i) => (
              <div key={i} className="settings-row">
                <select
                  aria-label="ステップの種類"
                  value={step.kind}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      steps: form.steps.map((s, j) =>
                        j === i ? { ...s, kind: e.target.value } : s,
                      ),
                    })
                  }
                >
                  {Object.entries(STEP_KIND_LABELS).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
                {step.kind === "item" && (
                  <select
                    aria-label="ステップの項目"
                    value={step.itemDefinitionId ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        steps: form.steps.map((s, j) =>
                          j === i ? { ...s, itemDefinitionId: e.target.value || null } : s,
                        ),
                      })
                    }
                  >
                    <option value="">項目を選ぶ</option>
                    {items.map((itemDef) => (
                      <option key={itemDef.id} value={itemDef.id}>
                        {itemDef.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={() => setForm({ ...form, steps: form.steps.filter((_, j) => j !== i) })}
                >
                  外す
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setForm({
                  ...form,
                  steps: [...form.steps, { kind: "time", itemDefinitionId: null }],
                })
              }
            >
              ステップを足す
            </button>
          </fieldset>
          <fieldset className="settings-checks">
            <legend>追加項目（詳細で付ける項目）</legend>
            {items.map((itemDef) => (
              <label key={itemDef.id}>
                <input
                  type="checkbox"
                  checked={form.itemDefinitionIds.includes(itemDef.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      itemDefinitionIds: e.target.checked
                        ? [...form.itemDefinitionIds, itemDef.id]
                        : form.itemDefinitionIds.filter((id) => id !== itemDef.id),
                    })
                  }
                />{" "}
                {itemDef.name}
              </label>
            ))}
          </fieldset>
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const saved = await api.upsertKindTemplate({
                      id: form.id ?? newRowId("tpl"),
                      key: form.key,
                      name: form.name,
                      subjectKind: form.subjectKind,
                      kindCode: form.kindCode,
                      personLabel: form.personLabel,
                      displaySource: form.displaySource,
                      steps: form.steps,
                      itemDefinitionIds: form.itemDefinitionIds,
                      sort: Number(form.sort) || 0,
                    });
                    setTemplates((list) =>
                      [...list.filter((t) => t.id !== saved.id), saved].sort(
                        (a, b) => a.sort - b.sort,
                      ),
                    );
                  },
                  () => setForm(null),
                )
              }
            >
              テンプレートを保存
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
