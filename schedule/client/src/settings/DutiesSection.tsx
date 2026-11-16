import { useState } from "react";
import type { DutyDefinitionData } from "../types";
import {
  DUTY_PERIOD_LABELS,
  GRANULARITY_LABELS,
  WEEKDAYS,
  newRowId,
  Section,
  type SectionCtx,
} from "./shared";

/** Duty definitions and their rotation rosters. The roster's
 *  order is the rotation's order; the panel edits it directly
 *  (the candidates of the duty panel are ranked from it). */
export function DutiesSection({ ctx }: { ctx: SectionCtx }) {
  const { duties, setDuties, api, run, busy, deleteButton, bootstrap, defs } = ctx;
  const staff = bootstrap.masters.staff;
  const [form, setForm] = useState<{
    id: string | null;
    name: string;
    granularity: string;
    applicablePeriod: string;
    startsOn: string;
    endsOn: string;
    targetGroupId: string;
    sort: string;
    useRotation: boolean;
    roster: string[];
    useWeekdays: boolean;
    weekdays: string[];
  } | null>(null);

  const openForm = (duty: DutyDefinitionData | null) => {
    setForm({
      id: duty?.id ?? null,
      name: duty?.name ?? "",
      granularity: duty?.granularity ?? "day",
      applicablePeriod: duty?.applicablePeriod ?? "all_year",
      startsOn: duty?.applicableStartsOn ?? "",
      endsOn: duty?.applicableEndsOn ?? "",
      targetGroupId: duty?.targetGroupId ?? "",
      sort: String(duty?.sort ?? duties.length + 1),
      useRotation: duty ? duty.rotation !== null : true,
      roster: duty?.rotation?.personIds ?? [],
      useWeekdays: duty?.rotation?.changeWeekdays != null,
      weekdays: duty?.rotation?.changeWeekdays ?? ["mon"],
    });
  };

  return (
    <Section title="当番定義と輪番">
      <ul className="settings-list">
        {duties.map((duty) => (
          <li key={duty.id}>
            <span>
              {duty.name}
              <span className="dim">
                （{GRANULARITY_LABELS[duty.granularity] ?? duty.granularity}／
                {DUTY_PERIOD_LABELS[duty.applicablePeriod] ?? duty.applicablePeriod}
                {duty.rotation
                  ? `／輪番：${duty.rotation.personIds.map((id) => staff.find((s) => s.id === id)?.name ?? id).join(" → ")}`
                  : "／輪番なし"}
                ）
              </span>
            </span>{" "}
            <button type="button" disabled={busy} onClick={() => openForm(duty)}>
              編集
            </button>{" "}
            {deleteButton(
              `duty:${duty.id}`,
              "削除",
              async () => {
                await api.deleteDutyDefinition({ id: duty.id });
                setDuties((list) => list.filter((d) => d.id !== duty.id));
              },
              // Duty definitions carry no is_active stop switch
              // (unlike item definitions), so the guidance is
              // not to delete when only the use ends.
              "削除すると、この当番の割当・交代の履歴・見送りの記録がすべて消えます。使うのをやめるだけなら、削除せずに残してください。",
            )}
          </li>
        ))}
      </ul>
      {form === null && (
        <button type="button" disabled={busy} onClick={() => openForm(null)}>
          当番を追加
        </button>
      )}
      {form && (
        <div className="settings-form">
          <label>
            当番の名前{" "}
            <input
              aria-label="当番の名前"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            粒度{" "}
            <select
              aria-label="当番の粒度"
              value={form.granularity}
              onChange={(e) => setForm({ ...form, granularity: e.target.value })}
            >
              <option value="day">日ごと</option>
              <option value="am_pm">午前・午後</option>
              <option value="week">週ごと</option>
              <option value="period">時限ごと</option>
            </select>
          </label>
          <label>
            適用期間{" "}
            <select
              aria-label="適用期間"
              value={form.applicablePeriod}
              onChange={(e) => setForm({ ...form, applicablePeriod: e.target.value })}
            >
              {Object.entries(DUTY_PERIOD_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {form.applicablePeriod === "custom_range" && (
            <>
              <label>
                開始日{" "}
                <input
                  aria-label="適用開始日"
                  type="date"
                  value={form.startsOn}
                  onChange={(e) => setForm({ ...form, startsOn: e.target.value })}
                />
              </label>
              <label>
                終了日{" "}
                <input
                  aria-label="適用終了日"
                  type="date"
                  value={form.endsOn}
                  onChange={(e) => setForm({ ...form, endsOn: e.target.value })}
                />
              </label>
            </>
          )}
          <label>
            対象軸（生徒の当番のとき）{" "}
            <select
              aria-label="当番の対象軸"
              value={form.targetGroupId}
              onChange={(e) => setForm({ ...form, targetGroupId: e.target.value })}
            >
              <option value="">なし（教職員）</option>
              {(defs?.targetGroups ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.useRotation}
              onChange={(e) => setForm({ ...form, useRotation: e.target.checked })}
            />{" "}
            輪番で自動的に割り当てる
          </label>
          {form.useRotation && (
            <>
              <fieldset className="settings-checks">
                <legend>輪番の顔ぶれ（この順に回ります）</legend>
                {form.roster.map((personId, i) => (
                  <div key={personId} className="settings-row">
                    <span>
                      {i + 1}. {staff.find((s) => s.id === personId)?.name ?? personId}
                    </span>
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() =>
                        setForm({
                          ...form,
                          roster: form.roster.map((p, j) =>
                            j === i - 1 ? personId : j === i ? (form.roster[i - 1] as string) : p,
                          ),
                        })
                      }
                    >
                      上へ
                    </button>
                    <button
                      type="button"
                      disabled={i === form.roster.length - 1}
                      onClick={() =>
                        setForm({
                          ...form,
                          roster: form.roster.map((p, j) =>
                            j === i + 1 ? personId : j === i ? (form.roster[i + 1] as string) : p,
                          ),
                        })
                      }
                    >
                      下へ
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setForm({ ...form, roster: form.roster.filter((p) => p !== personId) })
                      }
                    >
                      外す
                    </button>
                  </div>
                ))}
                {staff
                  .filter((s) => !form.roster.includes(s.id))
                  .map((s) => (
                    <div key={s.id} className="settings-row">
                      <span className="dim">{s.name}</span>
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, roster: [...form.roster, s.id] })}
                      >
                        輪番に足す
                      </button>
                    </div>
                  ))}
              </fieldset>
              <label>
                <input
                  type="checkbox"
                  checked={form.useWeekdays}
                  onChange={(e) => setForm({ ...form, useWeekdays: e.target.checked })}
                />{" "}
                交代する曜日を決める（決めない場合はマスごとに進みます）
              </label>
              {form.useWeekdays && (
                <fieldset className="settings-checks">
                  <legend>交代曜日</legend>
                  {WEEKDAYS.map((day) => (
                    <label key={day.code}>
                      <input
                        type="checkbox"
                        checked={form.weekdays.includes(day.code)}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            weekdays: e.target.checked
                              ? [...form.weekdays, day.code]
                              : form.weekdays.filter((d) => d !== day.code),
                          })
                        }
                      />{" "}
                      {day.label}
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          )}
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const saved = await api.upsertDutyDefinition({
                      id: form.id ?? newRowId("duty"),
                      name: form.name,
                      granularity: form.granularity,
                      applicablePeriod: form.applicablePeriod,
                      applicableStartsOn:
                        form.applicablePeriod === "custom_range" ? form.startsOn || null : null,
                      applicableEndsOn:
                        form.applicablePeriod === "custom_range" ? form.endsOn || null : null,
                      targetGroupId: form.targetGroupId || null,
                      sort: Number(form.sort) || 0,
                      rotation: form.useRotation
                        ? {
                            personIds: form.roster,
                            changeWeekdays: form.useWeekdays ? form.weekdays : null,
                          }
                        : null,
                    });
                    setDuties((list) =>
                      [...list.filter((d) => d.id !== saved.id), saved].sort(
                        (a, b) => a.sort - b.sort,
                      ),
                    );
                  },
                  () => setForm(null),
                )
              }
            >
              当番を保存
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
