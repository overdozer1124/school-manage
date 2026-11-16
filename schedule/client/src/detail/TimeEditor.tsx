import { ClockPicker } from "../ClockPicker";
import type { BootstrapData } from "../types";

/**
 * The detail modal's time editor (Issue #37): one state standing
 * for the record's CalendarTime — 終日 / 午前 / 午後 / 時刻指定
 * (the clock dial and direct text entry of ClockPicker) /
 * 時限指定 (the lesson periods of the day's pattern). The three
 * forms of the modal share it; only the label differs.
 */

export type TimeMode = "all_day" | "am" | "pm" | "clock" | "periods";

export interface TimeState {
  mode: TimeMode;
  start: string;
  end: string;
  periodFrom: string;
  periodTo: string;
}

export function timeStateOf(record: Record<string, unknown>): TimeState {
  const base: TimeState = { mode: "all_day", start: "", end: "", periodFrom: "", periodTo: "" };
  const time = record["time"];
  if (typeof time !== "object" || time === null) return base;
  const t = time as Record<string, unknown>;
  if (t["kind"] === "half_day") return { ...base, mode: t["half"] === "pm" ? "pm" : "am" };
  if (t["kind"] === "clock") {
    return {
      ...base,
      mode: "clock",
      start: typeof t["startsAt"] === "string" ? (t["startsAt"] as string) : "",
      end: typeof t["endsAt"] === "string" ? (t["endsAt"] as string) : "",
    };
  }
  if (t["kind"] === "periods") {
    return {
      ...base,
      mode: "periods",
      periodFrom: typeof t["from"] === "number" ? String(t["from"]) : "",
      periodTo: typeof t["to"] === "number" ? String(t["to"]) : "",
    };
  }
  return base;
}

/** The CalendarTime a time state stands for. An event that
 *  carried no time at all keeps carrying none while the mode
 *  stays 終日 — opening the modal must not rewrite a record the
 *  person did not touch. */
export function calendarTimeOf(state: TimeState, wasNull: boolean): Record<string, unknown> | null {
  switch (state.mode) {
    case "all_day":
      return wasNull ? null : { kind: "all_day" };
    case "am":
    case "pm":
      return { kind: "half_day", half: state.mode };
    case "clock":
      return { kind: "clock", startsAt: state.start, endsAt: state.end || null };
    case "periods":
      return { kind: "periods", from: Number(state.periodFrom), to: Number(state.periodTo) };
  }
}

export interface PeriodChoice {
  period: number;
  label: string;
}

/** The lesson periods of the day's pattern (0 is the morning
 *  band and 99 the after-school band; a CalendarTime names lesson
 *  periods, as the prototype's modal offered them). */
export function periodChoicesOf(
  bootstrap: BootstrapData,
  dayScheduleId: string | null,
): PeriodChoice[] {
  const pattern =
    bootstrap.masters.dayPatterns.find((p) => p.id === dayScheduleId) ??
    bootstrap.masters.dayPatterns[0];
  const periods = pattern?.["periods"];
  if (!Array.isArray(periods)) return [];
  const out: PeriodChoice[] = [];
  for (const entry of periods) {
    if (typeof entry !== "object" || entry === null) continue;
    const p = entry as Record<string, unknown>;
    if (typeof p["period"] !== "number" || p["period"] < 1 || p["period"] > 90) continue;
    out.push({
      period: p["period"] as number,
      label: typeof p["label"] === "string" ? (p["label"] as string) : `${p["period"]}限`,
    });
  }
  return out.sort((a, b) => a.period - b.period);
}

export function TimeEditor({
  label,
  state,
  periods,
  onChange,
}: {
  label: string;
  state: TimeState;
  periods: PeriodChoice[];
  onChange(state: TimeState): void;
}) {
  const modes: { mode: TimeMode; text: string }[] = [
    { mode: "all_day", text: "終日" },
    { mode: "am", text: "午前" },
    { mode: "pm", text: "午後" },
    { mode: "clock", text: "時刻指定" },
    ...(periods.length > 0 || state.mode === "periods"
      ? [{ mode: "periods" as TimeMode, text: "時限指定" }]
      : []),
  ];
  return (
    <div>
      <span className="detail-label">{label}</span>
      <div className="kind-chips" role="group" aria-label={label}>
        {modes.map((m) => (
          <button
            key={m.mode}
            type="button"
            aria-pressed={state.mode === m.mode}
            className={state.mode === m.mode ? "chip selected" : "chip"}
            onClick={() => onChange({ ...state, mode: m.mode })}
          >
            {m.text}
          </button>
        ))}
      </div>
      {state.mode === "clock" && (
        <div className="detail-grid">
          <ClockPicker
            label="開始"
            value={state.start}
            onChange={(v) => onChange({ ...state, start: v })}
          />
          <ClockPicker
            label="終了"
            value={state.end}
            onChange={(v) => onChange({ ...state, end: v })}
          />
        </div>
      )}
      {state.mode === "periods" && (
        <div className="detail-grid">
          <label>
            <span className="detail-label">開始時限</span>
            <select
              aria-label="開始時限"
              value={state.periodFrom}
              onChange={(e) => onChange({ ...state, periodFrom: e.target.value })}
            >
              <option value="">選ぶ</option>
              {periods.map((p) => (
                <option key={p.period} value={p.period}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="detail-label">終了時限</span>
            <select
              aria-label="終了時限"
              value={state.periodTo}
              onChange={(e) => onChange({ ...state, periodTo: e.target.value })}
            >
              <option value="">選ぶ</option>
              {periods.map((p) => (
                <option key={p.period} value={p.period}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
