import { useState } from "react";
import type { AbsenceSubdivisionData } from "../types";
import { ABSENCE_KINDS, newRowId, Section, type SectionCtx } from "./shared";

/**
 * The absence subdivisions (Issue #84): the school's own
 * classifications under the fixed absence kinds — 年休・特休
 * under 休暇， and any the school adds under the other kinds.
 * The definitions live in the platform (Issue #25); this section
 * maintains them through the relay actions, which are the
 * Admin's alone (school.admin), and what is saved here is what
 * the absence modal and the quick-entry popover offer, through
 * the bootstrap the App reads again after every save.
 *
 * There is no stored display order to edit: the platform returns
 * the definitions by kind, then by key, and the modal offers
 * them in that order — so the key is the order, and the form
 * says so. Renaming a key an absence already names is the
 * platform's call to refuse, as is deleting a classification an
 * absence still uses; both refusals arrive as wordings the
 * panel's error line can show as-is.
 */
export function SubdivisionsSection({ ctx }: { ctx: SectionCtx }) {
  const { subdivisions, setSubdivisions, api, run, busy, deleteButton, setNotice } = ctx;
  const [form, setForm] = useState<{
    id: string | null;
    code: string;
    revision: number;
    key: string;
    label: string;
  } | null>(null);

  const refresh = async () => {
    const { items } = await api.getSubdivisions();
    setSubdivisions(items);
  };

  const openForm = (code: string, record: AbsenceSubdivisionData | null) =>
    setForm({
      id: record?.id ?? null,
      code,
      revision: record?.revision ?? 1,
      key: record?.key ?? "",
      label: record?.label ?? "",
    });

  return (
    <Section title="休暇分類（不在の分類）">
      <p className="dim">
        不在の分類は共通基盤の定義です。並びは種類・キーの順で、モーダルの選択肢もこの順に出ます。並びを変えるときはキーを変更してください。
      </p>
      {ABSENCE_KINDS.map((kind) => {
        const rows = (subdivisions ?? []).filter((s) => s.code === kind.code);
        return (
          <div key={kind.code}>
            <h4>{kind.label}</h4>
            <ul className="settings-list">
              {rows.map((record) => (
                <li key={record.id}>
                  <span>
                    {record.label}（キー：{record.key}）
                  </span>{" "}
                  <button type="button" disabled={busy} onClick={() => openForm(kind.code, record)}>
                    編集
                  </button>{" "}
                  {deleteButton(
                    `subdivision:${record.id}`,
                    "削除",
                    async () => {
                      await api.deleteSubdivision({ id: record.id, revision: record.revision });
                      await refresh();
                    },
                    "使っている不在がある分類は削除できません。",
                  )}
                </li>
              ))}
            </ul>
            {form === null && (
              <button type="button" disabled={busy} onClick={() => openForm(kind.code, null)}>
                {kind.label}の分類を追加
              </button>
            )}
            {kind.code === "leave" && (
              <>
                {" "}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const { items } = await api.applyDefaultSubdivisions();
                      await refresh();
                      setNotice(
                        items.length > 0
                          ? `既定の休暇分類を${items.length}件入れました`
                          : "既定の休暇分類はすでに入っています",
                      );
                    })
                  }
                >
                  既定の休暇分類を入れる
                </button>
              </>
            )}
          </div>
        );
      })}
      {form && (
        <div className="settings-form">
          <label>
            名前{" "}
            <input
              aria-label="分類の名前"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </label>
          <label>
            キー{" "}
            <input
              aria-label="分類のキー"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
          </label>
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    if (form.id === null) {
                      await api.createSubdivision({
                        record: {
                          id: newRowId("subdiv"),
                          code: form.code,
                          key: form.key,
                          label: form.label,
                        },
                      });
                    } else {
                      await api.updateSubdivision({
                        id: form.id,
                        record: {
                          id: form.id,
                          code: form.code,
                          key: form.key,
                          label: form.label,
                          revision: form.revision,
                        },
                      });
                    }
                    await refresh();
                  },
                  () => setForm(null),
                )
              }
            >
              分類を保存
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
