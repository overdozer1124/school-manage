import { useState } from "react";
import { isCommitEnter } from "./cells";

/**
 * The analog clock picker (DESIGN schedule 6.3), ported from the
 * prototype's client/src/ClockPicker.tsx for this implementation's
 * plain-CSS theme: an Android-style dial — pick the hour (with
 * AM/PM), then the minute in 5-minute steps — with direct text
 * entry always beside it (6.4). The detail modal's issue reuses
 * this same component; the quick-entry popover's time step is its
 * first home (Issue #36).
 *
 * The value is "HH:MM" or "" (no time). Picking on the dial and
 * committing the text both go through onChange; the text input
 * also reports a plain Enter through onEnter, passing the value
 * the commit just settled, so a surrounding step flow saves that
 * value itself and never the state the commit has only just
 * queued — an Enter that only confirms an IME conversion never
 * counts (PR #75's rule).
 */
export function ClockPicker({
  label,
  value,
  onChange,
  onEnter,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onEnter?: (value: string) => void;
  autoFocus?: boolean;
}) {
  const [mode, setMode] = useState<"hour" | "minute">("hour");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);

  const [hhStr = "", mmStr = ""] = value.split(":");
  const hh = hhStr === "" ? null : Number(hhStr);
  const mm = mmStr === "" ? 0 : Number(mmStr);
  const isPm = hh != null && hh >= 12;
  const hour12 = hh == null ? null : hh % 12 === 0 ? 12 : hh % 12;

  const setHour12 = (h12: number, pm: boolean) => {
    let h = h12 % 12;
    if (pm) h += 12;
    onChange(`${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
    setMode("minute");
  };
  const setMinute = (m: number) => {
    const h = hh ?? 0;
    onChange(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  };

  /** Settles the typed text: a HH:MM entry (or an empty one)
   *  goes through onChange in normalized form; anything else is
   *  discarded and the settled value is the one already held.
   *  Returns the settled value, so an Enter can hand it on. */
  const commitText = (raw: string): string => {
    const m = raw.trim().match(/^(\d{1,2})[:：](\d{1,2})$/);
    let next = value;
    if (m) {
      const h = Math.min(23, Number(m[1]));
      const min = Math.min(59, Number(m[2]));
      next = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      onChange(next);
    } else if (raw.trim() === "") {
      next = "";
      onChange(next);
    }
    setText(null);
    return next;
  };

  const positions = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const r = 62;
      return { x: 90 + r * Math.cos(angle), y: 90 + r * Math.sin(angle) };
    });

  return (
    <div className="clock-picker">
      <span className="clock-picker-label">{label}</span>
      <div className="clock-picker-row">
        <input
          aria-label={`${label}（直接入力）`}
          className="clock-picker-input"
          placeholder="13:30"
          value={text ?? value}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commitText(e.target.value)}
          onKeyDown={(e) => {
            if (isCommitEnter(e)) {
              onEnter?.(commitText((e.target as HTMLInputElement).value));
            }
          }}
        />
        <button
          type="button"
          aria-label={`${label}を時計盤で選ぶ`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          時計盤
        </button>
        {value !== "" && (
          <button
            type="button"
            aria-label={`${label}をクリア`}
            className="clock-picker-clear"
            onClick={() => onChange("")}
          >
            クリア
          </button>
        )}
      </div>
      {open && (
        <div className="clock-dial-box">
          <div className="clock-dial-head">
            <button
              type="button"
              aria-label="午前"
              aria-pressed={!isPm}
              className={!isPm ? "selected" : undefined}
              onClick={() => {
                if (hh != null && isPm) {
                  onChange(`${String(hh - 12).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
                }
              }}
            >
              午前
            </button>
            <span className="clock-dial-value">{value === "" ? "--:--" : value}</span>
            <button
              type="button"
              aria-label="午後"
              aria-pressed={isPm}
              className={isPm ? "selected" : undefined}
              onClick={() => {
                if (hh != null && !isPm) {
                  onChange(`${String(hh + 12).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
                }
              }}
            >
              午後
            </button>
          </div>
          <div
            className="clock-dial"
            role="group"
            aria-label={mode === "hour" ? "時を選ぶ" : "分を選ぶ"}
          >
            <div className="clock-dial-face" />
            {mode === "hour"
              ? positions(12).map((p, i) => {
                  const h12 = i === 0 ? 12 : i;
                  const selected = hour12 === h12;
                  return (
                    <button
                      key={h12}
                      type="button"
                      aria-label={`${h12}時`}
                      aria-pressed={selected}
                      className={selected ? "clock-num selected" : "clock-num"}
                      style={{ left: p.x, top: p.y }}
                      onClick={() => setHour12(h12, isPm)}
                    >
                      {h12}
                    </button>
                  );
                })
              : positions(12).map((p, i) => {
                  const m = i * 5;
                  const selected = mm === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      aria-label={`${m}分`}
                      aria-pressed={selected}
                      className={selected ? "clock-num selected" : "clock-num"}
                      style={{ left: p.x, top: p.y }}
                      onClick={() => setMinute(m)}
                    >
                      {String(m).padStart(2, "0")}
                    </button>
                  );
                })}
          </div>
          <div className="clock-dial-foot">
            <button
              type="button"
              className={mode === "hour" ? "selected" : undefined}
              onClick={() => setMode("hour")}
            >
              時
            </button>
            <button
              type="button"
              className={mode === "minute" ? "selected" : undefined}
              onClick={() => setMode("minute")}
            >
              分（5分刻み）
            </button>
            <button type="button" className="clock-dial-close" onClick={() => setOpen(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
