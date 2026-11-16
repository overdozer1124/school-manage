import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { matchStaffByName, normalizeName } from "../lib";
import type { BootstrapData, KindTemplateData } from "../types";
import { VISIBILITY_OPTIONS, type Assignee } from "./shared";
import { TimeEditor, type PeriodChoice, type TimeState } from "./TimeEditor";

/**
 * The detail modal's form for a plain event (Issue #37, DESIGN
 * 6.3): title, kind, the date in its four precisions, the time,
 * the place (chosen from the registered places or typed — a typed
 * place stays free text, 6.4), the people (chosen or typed, a
 * typed name matching the roster becomes that person), the
 * targets, the additional items, the memo, and the closing pair
 * of visibility and certainty. The field state lives in the
 * modal; this is its rendering. Only the add-a-person scratch
 * state lives here, as nothing outside this form reads it.
 */
export function EventForm({
  bootstrap,
  title,
  onTitleChange,
  eventTemplates,
  kindKey,
  onKindKeyChange,
  precision,
  onPrecisionChange,
  startsOn,
  onStartsOnChange,
  endsOn,
  onEndsOnChange,
  onDayDateChange,
  monthVal,
  onMonthValChange,
  schoolYear,
  onSchoolYearChange,
  time,
  periods,
  onTimeChange,
  locationText,
  onLocationTextChange,
  personLabel,
  assignees,
  setAssignees,
  offeredTargets,
  targetKeys,
  setTargetKeys,
  itemFields,
  description,
  onDescriptionChange,
  visibility,
  onVisibilityChange,
  certaintyField,
}: {
  bootstrap: BootstrapData;
  title: string;
  onTitleChange(value: string): void;
  eventTemplates: KindTemplateData[];
  kindKey: string;
  onKindKeyChange(value: string): void;
  precision: string;
  onPrecisionChange(value: string): void;
  startsOn: string;
  onStartsOnChange(value: string): void;
  endsOn: string;
  onEndsOnChange(value: string): void;
  /** In day precision the one date field sets both ends. */
  onDayDateChange(value: string): void;
  monthVal: string;
  onMonthValChange(value: string): void;
  schoolYear: string;
  onSchoolYearChange(value: string): void;
  time: TimeState;
  periods: PeriodChoice[];
  onTimeChange(state: TimeState): void;
  locationText: string;
  onLocationTextChange(value: string): void;
  personLabel: string;
  assignees: Assignee[];
  setAssignees: Dispatch<SetStateAction<Assignee[]>>;
  offeredTargets: { key: string; label: string; group: string }[];
  targetKeys: string[];
  setTargetKeys: Dispatch<SetStateAction<string[]>>;
  itemFields: ReactNode;
  description: string;
  onDescriptionChange(value: string): void;
  visibility: string;
  onVisibilityChange(value: string): void;
  certaintyField: ReactNode;
}) {
  const [addPersonId, setAddPersonId] = useState("");
  const [addFreeName, setAddFreeName] = useState("");

  const addAssignee = (assignee: Assignee) => {
    setAssignees((current) => {
      if (
        assignee.kind === "staff" &&
        current.some((a) => a.kind === "staff" && a.staffId === assignee.staffId)
      ) {
        return current;
      }
      return [...current, assignee];
    });
  };

  return (
    <>
      <div>
        <label className="detail-label" htmlFor="detail-title">
          件名
        </label>
        <input
          id="detail-title"
          aria-label="件名"
          value={title}
          autoFocus
          onChange={(e) => onTitleChange(e.target.value)}
        />
      </div>
      <div className="detail-grid">
        <div>
          <label className="detail-label" htmlFor="detail-kind">
            種別
          </label>
          <select
            id="detail-kind"
            aria-label="種別"
            value={kindKey}
            onChange={(e) => onKindKeyChange(e.target.value)}
          >
            {eventTemplates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="detail-label" htmlFor="detail-precision">
            日付の確定度
          </label>
          <select
            id="detail-precision"
            aria-label="日付の確定度"
            value={precision}
            onChange={(e) => onPrecisionChange(e.target.value)}
          >
            <option value="day">日が確定</option>
            <option value="range">期間</option>
            <option value="month">月のみ確定</option>
            <option value="undecided">時期未定</option>
          </select>
        </div>
      </div>
      {precision === "day" && (
        <div>
          <label className="detail-label" htmlFor="detail-date">
            日付
          </label>
          <input
            id="detail-date"
            type="date"
            aria-label="日付"
            value={startsOn}
            onChange={(e) => onDayDateChange(e.target.value)}
          />
        </div>
      )}
      {precision === "range" && (
        <div className="detail-grid">
          <label>
            <span className="detail-label">開始日</span>
            <input
              type="date"
              aria-label="開始日"
              value={startsOn}
              onChange={(e) => onStartsOnChange(e.target.value)}
            />
          </label>
          <label>
            <span className="detail-label">終了日</span>
            <input
              type="date"
              aria-label="終了日"
              value={endsOn}
              onChange={(e) => onEndsOnChange(e.target.value)}
            />
          </label>
        </div>
      )}
      {precision === "month" && (
        <div>
          <label className="detail-label" htmlFor="detail-month">
            対象月
          </label>
          <input
            id="detail-month"
            type="month"
            aria-label="対象月"
            value={monthVal}
            onChange={(e) => onMonthValChange(e.target.value)}
          />
        </div>
      )}
      {precision === "undecided" && (
        <div>
          <label className="detail-label" htmlFor="detail-year">
            年度（時期未定）
          </label>
          <input
            id="detail-year"
            aria-label="年度"
            inputMode="numeric"
            value={schoolYear}
            onChange={(e) => onSchoolYearChange(e.target.value)}
          />
        </div>
      )}
      {precision !== "month" && precision !== "undecided" && (
        <TimeEditor label="時間" state={time} periods={periods} onChange={onTimeChange} />
      )}
      <div>
        <label className="detail-label" htmlFor="detail-location">
          場所（登録済みの場所から選択、または直接入力）
        </label>
        <input
          id="detail-location"
          aria-label="場所"
          value={locationText}
          list="detail-location-list"
          onChange={(e) => onLocationTextChange(e.target.value)}
        />
        <datalist id="detail-location-list">
          {bootstrap.locations
            .filter((l) => l.isActive)
            .map((l) => (
              <option key={l.id} value={l.name} />
            ))}
        </datalist>
        {locationText.trim() !== "" &&
          !bootstrap.locations.some(
            (l) => normalizeName(l.name) === normalizeName(locationText.trim()),
          ) && (
            <p className="detail-note">未登録の場所です。テキストとして保存されます（§6.4）。</p>
          )}
      </div>
      <div>
        <span className="detail-label">{personLabel}（複数選択可・直接入力可）</span>
        <div className="detail-people">
          {assignees.map((a, i) => (
            <span key={i} className="detail-person">
              {a.kind === "staff"
                ? (bootstrap.masters.staff.find((s) => s.id === a.staffId)?.name ?? a.staffId)
                : a.name}
              <button
                type="button"
                aria-label={`${a.kind === "staff" ? a.staffId : a.name}を外す`}
                onClick={() => setAssignees(assignees.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
          {assignees.length === 0 && <span className="detail-note">未設定</span>}
        </div>
        <div className="detail-add-person">
          <select
            aria-label={`登録済みの人から${personLabel}を選ぶ`}
            value={addPersonId}
            onChange={(e) => setAddPersonId(e.target.value)}
          >
            <option value="">登録済みの人から選ぶ</option>
            {bootstrap.masters.staff
              .filter((s) => typeof s.name === "string")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            onClick={() => {
              if (addPersonId === "") return;
              addAssignee({
                kind: "staff",
                staffId: addPersonId,
                role: personLabel,
              });
              setAddPersonId("");
            }}
          >
            追加
          </button>
          <input
            aria-label={`${personLabel}を直接入力`}
            placeholder="直接入力（氏名）"
            value={addFreeName}
            onChange={(e) => setAddFreeName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const name = addFreeName.trim();
                if (!name) return;
                const matched = matchStaffByName(name, bootstrap.masters.staff);
                addAssignee(
                  matched
                    ? { kind: "staff", staffId: matched.id, role: personLabel }
                    : { kind: "free_text", name, role: personLabel },
                );
                setAddFreeName("");
              }
            }}
          />
        </div>
      </div>
      {offeredTargets.length > 0 && (
        <div>
          <span className="detail-label">対象</span>
          {[...new Set(offeredTargets.map((o) => o.group))].map((group) => (
            <div key={group} className="detail-target-group">
              <span className="detail-target-name">{group}</span>
              <div className="detail-targets">
                {offeredTargets
                  .filter((o) => o.group === group)
                  .map((o) => (
                    <label key={o.key}>
                      <input
                        type="checkbox"
                        checked={targetKeys.includes(o.key)}
                        onChange={(e) =>
                          setTargetKeys(
                            e.target.checked
                              ? [...targetKeys, o.key]
                              : targetKeys.filter((k) => k !== o.key),
                          )
                        }
                      />{" "}
                      {o.label}
                    </label>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
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
