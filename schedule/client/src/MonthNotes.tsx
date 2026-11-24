import { useState } from "react";
import type { ScheduleApi } from "./api";
import type { RangeData } from "./types";

/**
 * The month's accompanying notes, heading the student table
 * (Issue #46; DESIGN schedule 7): the view's 生活目標・健康目標
 * for the anchor's month, read off the range bundle — the notes
 * are the view's monthly metadata, so they stand over the table
 * the way the goals head the printed sheet.
 *
 * With an api, the daily.write permission and an onSaved, the
 * header is also the input: 「今月の目標を編集」 opens the two
 * goal fields for the displayed month, and saving writes them
 * through setViewMonthNote and re-reads the range. Without them
 * (the public screen, a reader without the permission) the
 * header only reads — and when nothing is written and nothing
 * can be written, it stands aside entirely.
 */
export function MonthNotesHeader({
  range,
  anchor,
  api,
  canEdit = false,
  onSaved,
}: {
  range: RangeData;
  anchor: string;
  api?: ScheduleApi;
  canEdit?: boolean;
  onSaved?: () => void;
}) {
  const month = anchor.slice(0, 7);
  const note = range.monthNotes.find((n) => n.month === month) ?? null;
  const editable = api !== undefined && canEdit && onSaved !== undefined;
  const [editing, setEditing] = useState(false);
  const [lifeGoal, setLifeGoal] = useState("");
  const [healthGoal, setHealthGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasText = note !== null && (note.lifeGoal !== null || note.healthGoal !== null);
  if (!editing && !hasText && !editable) return null;

  const openEditor = () => {
    setLifeGoal(note?.lifeGoal ?? "");
    setHealthGoal(note?.healthGoal ?? "");
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (!api || !onSaved) return;
    setBusy(true);
    setError(null);
    try {
      await api.setViewMonthNote({
        viewId: range.view.id,
        month,
        lifeGoal: lifeGoal.trim() === "" ? null : lifeGoal.trim(),
        healthGoal: healthGoal.trim() === "" ? null : healthGoal.trim(),
      });
      setEditing(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <section className="month-notes month-notes-edit" aria-label="今月の目標">
        <label>
          生活目標{" "}
          <input
            aria-label="生活目標"
            value={lifeGoal}
            maxLength={100}
            onChange={(e) => setLifeGoal(e.target.value)}
          />
        </label>
        <label>
          健康目標{" "}
          <input
            aria-label="健康目標"
            value={healthGoal}
            maxLength={100}
            onChange={(e) => setHealthGoal(e.target.value)}
          />
        </label>
        {error && (
          <p className="month-notes-error" role="alert">
            {error}
          </p>
        )}
        <div className="month-notes-actions">
          <button type="button" onClick={() => void save()} disabled={busy}>
            保存
          </button>
          <button type="button" onClick={() => setEditing(false)} disabled={busy}>
            キャンセル
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="month-notes" aria-label="今月の目標">
      <div className="month-note-row">
        <span className="month-note-label">生活目標</span>
        <span className="month-note-text">{note?.lifeGoal ?? "（未設定）"}</span>
      </div>
      <div className="month-note-row">
        <span className="month-note-label">健康目標</span>
        <span className="month-note-text">{note?.healthGoal ?? "（未設定）"}</span>
      </div>
      {editable && (
        <button type="button" className="month-notes-edit-button" onClick={openEditor}>
          今月の目標を編集
        </button>
      )}
    </section>
  );
}
