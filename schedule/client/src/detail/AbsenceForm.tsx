import type { ReactNode } from "react";
import type { AbsenceSubdivisionData, BootstrapData, KindTemplateData } from "../types";
import { TimeEditor, type PeriodChoice, type TimeState } from "./TimeEditor";

/**
 * The detail modal's absence form (Issue #37, DESIGN 6.3.1): the
 * person leads, and a leave shows only the taker, the leave
 * classification, the dates, the time band and a memo — no title
 * field, no place. A trip carries its purpose （用務） instead.
 * The field state lives in the modal; this is its rendering.
 */
export function AbsenceForm({
  template,
  bootstrap,
  staffId,
  onStaffIdChange,
  isLeaveAbsence,
  purpose,
  onPurposeChange,
  subdivisionOptions,
  subdivisionKey,
  onSubdivisionKeyChange,
  fromDate,
  onFromDateChange,
  toDate,
  onToDateChange,
  time,
  periods,
  onTimeChange,
  itemFields,
  note,
  onNoteChange,
  certaintyField,
}: {
  template: KindTemplateData;
  bootstrap: BootstrapData;
  staffId: string;
  onStaffIdChange(value: string): void;
  isLeaveAbsence: boolean;
  purpose: string;
  onPurposeChange(value: string): void;
  subdivisionOptions: AbsenceSubdivisionData[];
  subdivisionKey: string;
  onSubdivisionKeyChange(value: string): void;
  fromDate: string;
  onFromDateChange(value: string): void;
  toDate: string;
  onToDateChange(value: string): void;
  time: TimeState;
  periods: PeriodChoice[];
  onTimeChange(state: TimeState): void;
  itemFields: ReactNode;
  note: string;
  onNoteChange(value: string): void;
  certaintyField: ReactNode;
}) {
  return (
    <>
      <div>
        <label className="detail-label" htmlFor="detail-staff">
          {template.personLabel}
        </label>
        <select
          id="detail-staff"
          aria-label={template.personLabel}
          value={staffId}
          autoFocus
          onChange={(e) => onStaffIdChange(e.target.value)}
        >
          <option value="">選んでください</option>
          {bootstrap.masters.staff
            .filter((s) => typeof s.name === "string")
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </div>
      {!isLeaveAbsence && (
        <div>
          <label className="detail-label" htmlFor="detail-purpose">
            用務
          </label>
          <input
            id="detail-purpose"
            aria-label="用務"
            value={purpose}
            onChange={(e) => onPurposeChange(e.target.value)}
          />
        </div>
      )}
      {subdivisionOptions.length > 0 && (
        <div>
          <label className="detail-label" htmlFor="detail-subdivision">
            {isLeaveAbsence ? "休暇分類" : `${template.name}分類`}
          </label>
          <select
            id="detail-subdivision"
            aria-label={isLeaveAbsence ? "休暇分類" : `${template.name}分類`}
            value={subdivisionKey}
            onChange={(e) => onSubdivisionKeyChange(e.target.value)}
          >
            <option value="">（なし）</option>
            {subdivisionOptions.map((o) => (
              <option key={o.id} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="detail-grid">
        <label>
          <span className="detail-label">開始日</span>
          <input
            type="date"
            aria-label="開始日"
            value={fromDate}
            onChange={(e) => onFromDateChange(e.target.value)}
          />
        </label>
        <label>
          <span className="detail-label">終了日</span>
          <input
            type="date"
            aria-label="終了日"
            value={toDate}
            onChange={(e) => onToDateChange(e.target.value)}
          />
        </label>
      </div>
      <TimeEditor label="時間帯" state={time} periods={periods} onChange={onTimeChange} />
      {itemFields}
      <div>
        <label className="detail-label" htmlFor="detail-note">
          メモ
        </label>
        <textarea
          id="detail-note"
          aria-label="メモ"
          rows={2}
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
        />
      </div>
      {certaintyField}
    </>
  );
}
