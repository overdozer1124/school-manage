import type { ReactNode } from "react";
import type { KindTemplateData } from "../types";
import { VISIBILITY_OPTIONS } from "./shared";
import { TimeEditor, type PeriodChoice, type TimeState } from "./TimeEditor";

/**
 * The detail modal's form for a provisional entry (Issue #37): an
 * event standing in for an absence kind — a placeholder name or a
 * title-only trip (cells.tsx). The form keeps the absence
 * template's framing and the record's shape: rewriting it here
 * never turns it into an absence — that conversion stays with the
 * cell's inline re-edit, where the roster match is the whole act
 * (PR #75). The field state lives in the modal; this is its
 * rendering.
 */
export function ProvisionalForm({
  template,
  textLabel,
  text,
  onTextChange,
  date,
  onDateChange,
  time,
  periods,
  onTimeChange,
  itemFields,
  description,
  onDescriptionChange,
  visibility,
  onVisibilityChange,
  certaintyField,
}: {
  template: KindTemplateData;
  /** 「〜の名前」 when the entry carries a placeholder name,
   *  「件名」 when it is a title-only entry. */
  textLabel: string;
  text: string;
  onTextChange(value: string): void;
  date: string;
  onDateChange(value: string): void;
  time: TimeState;
  periods: PeriodChoice[];
  onTimeChange(state: TimeState): void;
  itemFields: ReactNode;
  description: string;
  onDescriptionChange(value: string): void;
  visibility: string;
  onVisibilityChange(value: string): void;
  certaintyField: ReactNode;
}) {
  return (
    <>
      <p className="detail-note">
        仮の予定です。{template.personLabel}
        が決まったら、セルの再編集で名簿の名前に書き換えると不在として登録されます。
      </p>
      <div>
        <label className="detail-label" htmlFor="detail-provisional-text">
          {textLabel}
        </label>
        <input
          id="detail-provisional-text"
          aria-label={textLabel}
          value={text}
          autoFocus
          onChange={(e) => onTextChange(e.target.value)}
        />
      </div>
      <div>
        <label className="detail-label" htmlFor="detail-provisional-date">
          日付
        </label>
        <input
          id="detail-provisional-date"
          type="date"
          aria-label="日付"
          value={date}
          onChange={(e) => onDateChange(e.target.value)}
        />
      </div>
      <TimeEditor label="時間" state={time} periods={periods} onChange={onTimeChange} />
      {itemFields}
      <div>
        <label className="detail-label" htmlFor="detail-description">
          メモ
        </label>
        <textarea
          id="detail-description"
          aria-label="メモ"
          rows={2}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
        />
      </div>
      <div className="detail-grid">
        <div>
          <span className="detail-label">公開範囲</span>
          <select
            aria-label="公開範囲"
            value={visibility}
            onChange={(e) => onVisibilityChange(e.target.value)}
          >
            {VISIBILITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {certaintyField}
      </div>
    </>
  );
}
