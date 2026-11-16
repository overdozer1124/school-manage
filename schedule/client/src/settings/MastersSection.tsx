import { useState } from "react";
import type { MasterKindData } from "../types";
import { newRowId, Section, type SectionCtx } from "./shared";

const MASTER_KIND_LABELS: Record<MasterKindData, string> = {
  staff: "教職員",
  grade: "学年",
  class: "クラス",
  special_needs_class: "特別支援学級",
  day_pattern: "日課・時限",
};
const DAY_PATTERN_KIND_LABELS: Record<string, string> = {
  normal: "通常",
  shortened: "短縮",
  exam: "考査",
  special: "特別",
};

function masterText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}
function masterNum(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

interface PeriodDraft {
  period: string;
  label: string;
  startsAt: string;
  endsAt: string;
}

/** The shared masters, edited through the relay: the platform
 *  owns them (staff, grades, classes, special-needs classes,
 *  day patterns with their periods) and judges every write. */
export function MastersSection({ ctx }: { ctx: SectionCtx }) {
  const { masters, setMasters, api, run, busy, deleteButton } = ctx;
  const [kind, setKind] = useState<MasterKindData>("staff");
  const [form, setForm] = useState<{
    id: string | null;
    revision: number;
    fields: Record<string, string | boolean>;
    periods: PeriodDraft[];
  } | null>(null);

  const records: Record<string, unknown>[] = masters
    ? (masters[kind] as Record<string, unknown>[])
    : [];
  const grades = masters?.grade ?? [];

  const replaceRecord = (record: Record<string, unknown>) =>
    setMasters((current) =>
      current
        ? {
            ...current,
            [kind]: [
              ...(current[kind] as Record<string, unknown>[]).filter(
                (r) => r["id"] !== record["id"],
              ),
              record,
            ].sort((a, b) => masterNum(a, "sortOrder") - masterNum(b, "sortOrder")),
          }
        : current,
    );

  const openForm = (record: Record<string, unknown> | null) => {
    const fields: Record<string, string | boolean> = {};
    if (kind === "staff") {
      fields.name = record ? masterText(record, "name") : "";
      fields.shortName = record ? masterText(record, "shortName") : "";
      fields.sortOrder = String(record ? masterNum(record, "sortOrder") : records.length + 1);
      fields.active = record ? record["active"] !== false : true;
      fields.personId = record ? masterText(record, "personId") : "";
    } else if (kind === "grade") {
      fields.name = record ? masterText(record, "name") : "";
      fields.sortOrder = String(record ? masterNum(record, "sortOrder") : records.length + 1);
      fields.stage = record ? masterText(record, "stage") : "";
    } else if (kind === "class") {
      fields.name = record ? masterText(record, "name") : "";
      fields.gradeId = record
        ? masterText(record, "gradeId")
        : ((grades[0]?.["id"] as string) ?? "");
      fields.sortOrder = String(record ? masterNum(record, "sortOrder") : records.length + 1);
    } else if (kind === "special_needs_class") {
      fields.name = record ? masterText(record, "name") : "";
      fields.sortOrder = String(record ? masterNum(record, "sortOrder") : records.length + 1);
    } else {
      fields.code = record ? masterText(record, "code") : "";
      fields.name = record ? masterText(record, "name") : "";
      fields.kind = record ? masterText(record, "kind") || "normal" : "normal";
    }
    const periods: PeriodDraft[] =
      kind === "day_pattern"
        ? (
            (record?.["periods"] as
              | { period: number; label: string; startsAt: string; endsAt: string }[]
              | undefined) ?? [{ period: 1, label: "1限", startsAt: "08:45", endsAt: "09:35" }]
          ).map((p) => ({
            period: String(p.period),
            label: p.label,
            startsAt: p.startsAt,
            endsAt: p.endsAt,
          }))
        : [];
    setForm({
      id: record ? String(record["id"]) : null,
      revision: record ? masterNum(record, "revision") || 1 : 1,
      fields,
      periods,
    });
  };

  const buildRecord = (): Record<string, unknown> => {
    const f = form?.fields ?? {};
    const base: Record<string, unknown> = { id: form?.id ?? newRowId("m") };
    if (kind === "staff") {
      base.name = f.name;
      base.shortName = f.shortName || f.name;
      base.sortOrder = Number(f.sortOrder) || 0;
      base.active = f.active === true;
      base.personId = f.personId ? String(f.personId) : null;
    } else if (kind === "grade") {
      base.name = f.name;
      base.sortOrder = Number(f.sortOrder) || 0;
      base.stage = f.stage ? String(f.stage) : null;
    } else if (kind === "class") {
      base.gradeId = f.gradeId;
      base.name = f.name;
      base.sortOrder = Number(f.sortOrder) || 0;
    } else if (kind === "special_needs_class") {
      base.name = f.name;
      base.sortOrder = Number(f.sortOrder) || 0;
    } else {
      base.code = f.code;
      base.name = f.name;
      base.kind = f.kind;
      base.periods = (form?.periods ?? []).map((p) => ({
        period: Number(p.period) || 0,
        label: p.label,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
      }));
    }
    return base;
  };

  const setField = (key: string, value: string | boolean) =>
    setForm((current) =>
      current ? { ...current, fields: { ...current.fields, [key]: value } } : current,
    );

  const recordLabel = (record: Record<string, unknown>): string => {
    if (kind === "day_pattern") {
      const periods = Array.isArray(record["periods"]) ? record["periods"].length : 0;
      return `${masterText(record, "code")} ${masterText(record, "name")}（${DAY_PATTERN_KIND_LABELS[masterText(record, "kind")] ?? ""}／${periods}時限）`;
    }
    if (kind === "staff") {
      return `${masterText(record, "name")}${record["active"] === false ? "（停止中）" : ""}`;
    }
    if (kind === "class") {
      const grade = grades.find((g) => g["id"] === record["gradeId"]);
      return `${grade ? masterText(grade as Record<string, unknown>, "name") : ""} ${masterText(record, "name")}`;
    }
    return masterText(record, "name");
  };

  return (
    <Section title="共通マスタ（基盤と共有）">
      <p className="dim">
        教職員・学年・クラス・特別支援学級・日課は共通基盤のマスタです。ここでの変更は基盤側で判定され、ほかのアプリにも届きます。
      </p>
      <div className="settings-row" role="tablist" aria-label="マスタの種類">
        {(Object.keys(MASTER_KIND_LABELS) as MasterKindData[]).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            className={kind === k ? "accent-button" : undefined}
            onClick={() => {
              setKind(k);
              setForm(null);
            }}
          >
            {MASTER_KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <ul className="settings-list">
        {records.map((record) => (
          <li key={String(record["id"])}>
            <span>{recordLabel(record)}</span>{" "}
            <button type="button" disabled={busy} onClick={() => openForm(record)}>
              編集
            </button>{" "}
            {deleteButton(`master:${kind}:${String(record["id"])}`, "削除", async () => {
              await api.deleteMaster({
                kind,
                id: String(record["id"]),
                revision: masterNum(record, "revision") || 1,
              });
              setMasters((current) =>
                current
                  ? {
                      ...current,
                      [kind]: (current[kind] as Record<string, unknown>[]).filter(
                        (r) => r["id"] !== record["id"],
                      ),
                    }
                  : current,
              );
            })}
          </li>
        ))}
      </ul>
      {form === null && (
        <button type="button" disabled={busy} onClick={() => openForm(null)}>
          {MASTER_KIND_LABELS[kind]}を追加
        </button>
      )}
      {form && (
        <div className="settings-form">
          {kind === "day_pattern" && (
            <label>
              コード{" "}
              <input
                aria-label="日課のコード"
                value={String(form.fields.code ?? "")}
                onChange={(e) => setField("code", e.target.value)}
              />
            </label>
          )}
          <label>
            名前{" "}
            <input
              aria-label="マスタの名前"
              value={String(form.fields.name ?? "")}
              onChange={(e) => setField("name", e.target.value)}
            />
          </label>
          {kind === "staff" && (
            <>
              <label>
                略称{" "}
                <input
                  aria-label="略称"
                  value={String(form.fields.shortName ?? "")}
                  onChange={(e) => setField("shortName", e.target.value)}
                />
              </label>
              <label>
                ログイン利用者のID（任意）{" "}
                <input
                  aria-label="ログイン利用者のID"
                  value={String(form.fields.personId ?? "")}
                  onChange={(e) => setField("personId", e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.fields.active === true}
                  onChange={(e) => setField("active", e.target.checked)}
                />{" "}
                在籍中
              </label>
            </>
          )}
          {kind === "grade" && (
            <label>
              課程（任意）{" "}
              <input
                aria-label="課程"
                value={String(form.fields.stage ?? "")}
                onChange={(e) => setField("stage", e.target.value)}
              />
            </label>
          )}
          {kind === "class" && (
            <label>
              学年{" "}
              <select
                aria-label="クラスが属する学年"
                value={String(form.fields.gradeId ?? "")}
                onChange={(e) => setField("gradeId", e.target.value)}
              >
                {grades.map((grade) => (
                  <option key={String(grade["id"])} value={String(grade["id"])}>
                    {masterText(grade as Record<string, unknown>, "name")}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === "day_pattern" && (
            <>
              <label>
                種別{" "}
                <select
                  aria-label="日課の種別"
                  value={String(form.fields.kind ?? "normal")}
                  onChange={(e) => setField("kind", e.target.value)}
                >
                  {Object.entries(DAY_PATTERN_KIND_LABELS).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="settings-checks">
                <legend>時限と時刻</legend>
                {form.periods.map((period, i) => (
                  <div key={i} className="settings-row">
                    <input
                      aria-label="時限番号"
                      type="number"
                      value={period.period}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          periods: form.periods.map((p, j) =>
                            j === i ? { ...p, period: e.target.value } : p,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label="時限の表示"
                      value={period.label}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          periods: form.periods.map((p, j) =>
                            j === i ? { ...p, label: e.target.value } : p,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label="開始時刻"
                      type="time"
                      value={period.startsAt}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          periods: form.periods.map((p, j) =>
                            j === i ? { ...p, startsAt: e.target.value } : p,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label="終了時刻"
                      type="time"
                      value={period.endsAt}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          periods: form.periods.map((p, j) =>
                            j === i ? { ...p, endsAt: e.target.value } : p,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setForm({ ...form, periods: form.periods.filter((_, j) => j !== i) })
                      }
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
                      periods: [
                        ...form.periods,
                        {
                          period: String(form.periods.length + 1),
                          label: `${form.periods.length + 1}限`,
                          startsAt: "13:30",
                          endsAt: "14:20",
                        },
                      ],
                    })
                  }
                >
                  時限を足す
                </button>
              </fieldset>
            </>
          )}
          {kind !== "day_pattern" && (
            <label>
              並び順{" "}
              <input
                aria-label="マスタの並び順"
                type="number"
                value={String(form.fields.sortOrder ?? "")}
                onChange={(e) => setField("sortOrder", e.target.value)}
              />
            </label>
          )}
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const record = buildRecord();
                    const saved =
                      form.id === null
                        ? await api.createMaster({ kind, record })
                        : await api.updateMaster({
                            kind,
                            id: form.id,
                            record: { ...record, revision: form.revision },
                          });
                    replaceRecord(saved);
                  },
                  () => setForm(null),
                )
              }
            >
              {MASTER_KIND_LABELS[kind]}を保存
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
