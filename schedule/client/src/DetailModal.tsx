import { useEffect, useState } from "react";
import { isValidTimeString, timeToMinutes } from "@school-manage/calendar-types";
import { ForbiddenError, UnauthorizedError, type ScheduleApi } from "./api";
import { buildFreeTextEntry, buildTitleOnlyEntry } from "./cells";
import { ClockPicker } from "./ClockPicker";
import { eventValueInputOf } from "./QuickPopover";
import {
  freeTextNameOf,
  matchStaffByName,
  normalizeName,
  provisionalLineText,
  schoolYearOf,
} from "./lib";
import type {
  BootstrapData,
  EventValueData,
  ItemDefinitionData,
  KindTemplateData,
  TargetRefData,
} from "./types";

/**
 * The detail modal (Issue #37; DESIGN schedule 6.3 / 6.3.1): an
 * existing entry, clicked in its cell, opens here and every field
 * the record carries can be edited — the quick-entry popover
 * (6.5) is the front step that adds the minimum right after
 * input, this is the screen for settling an entry properly, and
 * its 「詳細を開く」 button lands here too. The fields follow the
 * entry's kind template: a leave shows the taker, the leave
 * classification, the time band and a memo — no title field, no
 * place (6.3.1) — while an event shows its title, place,
 * assignees, targets and the rest of 6.3's table. Which additional
 * items (event_values) appear is the template's binding: its
 * 追加項目 (itemDefinitionIds, the settings screen's wording) and
 * any item step it carries.
 *
 * Saving is one act, as in the prototype: the record goes first,
 * then the additional items as one rewritten set (the read-back
 * helper of the popover keeps the items this form does not
 * touch). A failure of the items alone is said plainly and the
 * form stays open on the saved record, so one more 保存 retries
 * only what is left. Certainty follows DESIGN-AUTH-TENANCY 4.6:
 * a Viewer is never offered 確定 — no select, no button — while
 * an Editor or Admin meeting a tentative entry gets a 「確定する」
 * button beside 保存.
 *
 * A provisional entry (a placeholder name, a title-only trip —
 * cells.tsx) opens here as what it is: an event standing in for
 * an absence kind. Its form keeps the absence template's framing
 * and its record's shape: rewriting it here never turns it into
 * an absence — that conversion stays with the cell's inline
 * re-edit, where the roster match is the whole act (PR #75).
 */

export interface DetailTarget {
  subjectKind: "event" | "absence";
  template: KindTemplateData;
  record: Record<string, unknown>;
  /** The day the entry was opened from: its day pattern's
   *  periods are the 時限指定 choices. */
  date: string;
  dayScheduleId: string | null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function revisionOf(record: Record<string, unknown>): number | null {
  const value = record["revision"];
  return typeof value === "number" ? value : null;
}

type Assignee =
  | { kind: "staff"; staffId: string; role: string | null }
  | { kind: "free_text"; name: string; role: string | null };

function assigneesOf(record: Record<string, unknown>): Assignee[] {
  const list = record["assignees"];
  if (!Array.isArray(list)) return [];
  const out: Assignee[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const a = entry as Record<string, unknown>;
    const role = typeof a["role"] === "string" ? (a["role"] as string) : null;
    if (a["kind"] === "staff" && typeof a["staffId"] === "string") {
      out.push({ kind: "staff", staffId: a["staffId"] as string, role });
    } else if (a["kind"] === "free_text" && typeof a["name"] === "string") {
      out.push({ kind: "free_text", name: a["name"] as string, role });
    }
  }
  return out;
}

// ---- the time editor ------------------------------------------------

type TimeMode = "all_day" | "am" | "pm" | "clock" | "periods";

interface TimeState {
  mode: TimeMode;
  start: string;
  end: string;
  periodFrom: string;
  periodTo: string;
}

function timeStateOf(record: Record<string, unknown>): TimeState {
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
function calendarTimeOf(state: TimeState, wasNull: boolean): Record<string, unknown> | null {
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

interface PeriodChoice {
  period: number;
  label: string;
}

/** The lesson periods of the day's pattern (0 is the morning
 *  band and 99 the after-school band; a CalendarTime names lesson
 *  periods, as the prototype's modal offered them). */
function periodChoicesOf(bootstrap: BootstrapData, dayScheduleId: string | null): PeriodChoice[] {
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

function TimeEditor({
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

// ---- the additional items (event_values) ----------------------------

interface ItemDraft {
  text: string;
  end: string;
}

function draftOfRow(row: EventValueData, itemDef: ItemDefinitionData): ItemDraft {
  switch (itemDef.valueType) {
    case "symbol":
    case "code":
      return {
        text: itemDef.options.find((o) => o.id === row.valueOptionId)?.code ?? "",
        end: "",
      };
    case "time":
      return { text: row.valueTime ?? "", end: "" };
    case "time_range":
      return { text: row.valueTime ?? "", end: row.valueTimeEnd ?? "" };
    case "number":
      return { text: row.valueNumber !== null ? String(row.valueNumber) : "", end: "" };
    case "boolean":
      return { text: row.valueBoolean === null ? "" : String(row.valueBoolean), end: "" };
    case "person":
      return { text: row.valuePersonId ?? "", end: "" };
    default:
      return { text: row.valueText ?? "", end: "" };
  }
}

/** The value a draft sends, or undefined when the draft is not a
 *  value the item can hold (the caller names the item and stops). */
function draftValueOf(itemDef: ItemDefinitionData, draft: ItemDraft): unknown {
  const text = draft.text.trim();
  switch (itemDef.valueType) {
    case "text":
      return text === "" ? null : text;
    case "symbol":
    case "code":
    case "person":
      return text === "" ? null : text;
    case "time":
      return text === "" ? null : isValidTimeString(text) ? text : undefined;
    case "time_range": {
      const end = draft.end.trim();
      if (text === "" && end === "") return null;
      if (!isValidTimeString(text) || !isValidTimeString(end)) return undefined;
      if (timeToMinutes(end) <= timeToMinutes(text)) return undefined;
      return { startsAt: text, endsAt: end };
    }
    case "number": {
      if (text === "") return null;
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case "boolean":
      return text === "" ? null : text === "true";
    default:
      return text === "" ? null : text;
  }
}

/** The item definitions a template binds as its additional items:
 *  its 追加項目 (itemDefinitionIds) first, then any item step's
 *  binding not already among them. Types this form cannot edit
 *  (persons lists, per-target time maps) are left out of the form;
 *  their stored rows are still carried through a save untouched. */
const EDITABLE_VALUE_TYPES = [
  "text",
  "symbol",
  "code",
  "time",
  "time_range",
  "number",
  "boolean",
  "person",
];

function itemDefsOf(template: KindTemplateData, bootstrap: BootstrapData): ItemDefinitionData[] {
  const ids: string[] = [];
  for (const id of template.itemDefinitionIds ?? []) if (!ids.includes(id)) ids.push(id);
  for (const step of template.steps) {
    if (step.kind === "item" && step.itemDefinitionId && !ids.includes(step.itemDefinitionId)) {
      ids.push(step.itemDefinitionId);
    }
  }
  return ids
    .map((id) => bootstrap.itemDefinitions.find((i) => i.id === id))
    .filter(
      (d): d is ItemDefinitionData => d !== undefined && EDITABLE_VALUE_TYPES.includes(d.valueType),
    );
}

// ---- the modal --------------------------------------------------------

const VISIBILITY_OPTIONS: { value: string; label: string }[] = [
  { value: "staff_only", label: "職員のみ" },
  { value: "guardian", label: "保護者" },
  { value: "student", label: "生徒" },
  { value: "public", label: "公開" },
];

export function DetailModal({
  target,
  bootstrap,
  api,
  onSaved,
  onUnauthorizedError,
  onClose,
}: {
  target: DetailTarget;
  bootstrap: BootstrapData;
  api: ScheduleApi;
  /** A save or delete landed: the app re-reads the range. */
  onSaved(): void;
  onUnauthorizedError(): void;
  onClose(): void;
}) {
  const { subjectKind, template } = target;
  const isViewer = bootstrap.role === "Viewer";
  const [record, setRecord] = useState(target.record);
  const recordId = stringField(record, "id") ?? "";
  const provisional =
    subjectKind === "event" &&
    stringField(record, "kind") === "other" &&
    stringField(record, "kindLabel") === template.name &&
    template.subjectKind === "absence"
      ? template
      : null;
  const isLeaveAbsence = subjectKind === "absence" && template.displaySource === "person";

  // ---- shared form state ---------------------------------------
  const [time, setTime] = useState<TimeState>(() => timeStateOf(target.record));
  const [certainty, setCertainty] = useState(
    () => stringField(target.record, "certainty") ?? "confirmed",
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ---- event form state ----------------------------------------
  const eventTemplates = bootstrap.kindTemplates.filter((t) => t.subjectKind === "event");
  const [kindKey, setKindKey] = useState(template.key);
  const chosenTemplate = eventTemplates.find((t) => t.key === kindKey) ?? template;
  const [title, setTitle] = useState(() => stringField(target.record, "title") ?? "");
  const [precision, setPrecision] = useState(
    () => stringField(target.record, "datePrecision") ?? "day",
  );
  const [startsOn, setStartsOn] = useState(
    () => stringField(target.record, "startsOn") ?? target.date,
  );
  const [endsOn, setEndsOn] = useState(
    () =>
      stringField(target.record, "endsOn") ?? stringField(target.record, "startsOn") ?? target.date,
  );
  const [monthVal, setMonthVal] = useState(() =>
    (stringField(target.record, "startsOn") ?? target.date).slice(0, 7),
  );
  const [schoolYear, setSchoolYear] = useState(() =>
    String(schoolYearOf(stringField(target.record, "startsOn") ?? target.date)),
  );
  const [locationText, setLocationText] = useState(() => {
    const id = stringField(target.record, "locationId");
    const found = id ? bootstrap.locations.find((l) => l.id === id) : undefined;
    return found?.name ?? stringField(target.record, "locationText") ?? "";
  });
  const [assignees, setAssignees] = useState<Assignee[]>(() => assigneesOf(target.record));
  const [addPersonId, setAddPersonId] = useState("");
  const [addFreeName, setAddFreeName] = useState("");
  const [visibility, setVisibility] = useState(
    () => stringField(target.record, "visibility") ?? "staff_only",
  );
  const [description, setDescription] = useState(
    () => stringField(target.record, "description") ?? "",
  );

  // The targets the form offers: the app's own target groups and
  // the platform's grade axis. A stored target the form does not
  // offer is preserved untouched, never dropped by a save.
  const offeredTargets: { key: string; label: string; group: string; ref: TargetRefData }[] = [];
  for (const grade of bootstrap.masters.grades) {
    offeredTargets.push({
      key: `grade:${grade.id}`,
      label: grade.name ?? grade.id,
      group: "学年",
      ref: { axis: "grade", id: grade.id },
    });
  }
  for (const group of bootstrap.targetGroups) {
    for (const t of group.targets) {
      offeredTargets.push({
        key: `app:${group.key}:${t.id}`,
        label: t.name,
        group: group.name,
        ref: { axis: "app", app: "schedule", axisKey: group.key, id: t.id },
      });
    }
  }
  const refKey = (ref: TargetRefData): string =>
    ref.axis === "app" ? `app:${ref.axisKey}:${ref.id}` : `${ref.axis}:${ref.id}`;
  const storedTargets = (target.record["targets"] as TargetRefData[] | undefined) ?? [];
  const [targetKeys, setTargetKeys] = useState<string[]>(() => storedTargets.map(refKey));

  // ---- absence form state --------------------------------------
  const [staffId, setStaffId] = useState(() => stringField(target.record, "staffId") ?? "");
  const [fromDate, setFromDate] = useState(
    () => stringField(target.record, "fromDate") ?? target.date,
  );
  const [toDate, setToDate] = useState(() => stringField(target.record, "toDate") ?? target.date);
  const [purpose, setPurpose] = useState(() => stringField(target.record, "purpose") ?? "");
  const [note, setNote] = useState(() => stringField(target.record, "note") ?? "");
  const [subdivisionKey, setSubdivisionKey] = useState<string>(
    () => stringField(target.record, "subdivisionKey") ?? "",
  );
  const subdivisionOptions = bootstrap.absenceSubdivisions.filter(
    (s) => s.code === (stringField(target.record, "kind") ?? template.kindCode),
  );

  // ---- provisional form state ----------------------------------
  const [provisionalText, setProvisionalText] = useState(() => provisionalLineText(target.record));
  const [provisionalDate, setProvisionalDate] = useState(
    () => stringField(target.record, "startsOn") ?? target.date,
  );

  // ---- additional items ----------------------------------------
  const itemDefs = itemDefsOf(template, bootstrap);
  const [valueRows, setValueRows] = useState<EventValueData[] | null>(null);
  const [valueDrafts, setValueDrafts] = useState<Record<string, ItemDraft>>({});
  const [valuesFailed, setValuesFailed] = useState(false);
  useEffect(() => {
    if (itemDefs.length === 0) {
      setValueRows([]);
      return;
    }
    let cancelled = false;
    api
      .getEventValues({ subjectKind, subjectId: recordId })
      .then((rows) => {
        if (cancelled) return;
        setValueRows(rows);
        const drafts: Record<string, ItemDraft> = {};
        for (const def of itemDefs) {
          const row = rows.find(
            (r) => r.itemDefinitionId === def.id && !r.targetId && !r.targetRef,
          );
          drafts[def.id] = row ? draftOfRow(row, def) : { text: "", end: "" };
        }
        setValueDrafts(drafts);
      })
      .catch(() => {
        if (!cancelled) setValuesFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // The form opens on one record; the read happens once.
  }, []);

  const periods = periodChoicesOf(bootstrap, target.dayScheduleId);
  const heading = `${template.name}の詳細`;
  const personLabel =
    subjectKind === "absence" || provisional ? template.personLabel : chosenTemplate.personLabel;

  const fail = (cause: unknown) => {
    if (cause instanceof UnauthorizedError) {
      onUnauthorizedError();
      return;
    }
    if (cause instanceof ForbiddenError) {
      setNotice("権限がありません");
      return;
    }
    setNotice(
      cause instanceof Error && cause.message
        ? `保存できませんでした：${cause.message}`
        : "保存できませんでした",
    );
  };

  /** The additional items as one rewritten set: the stored rows
   *  read back through the popover's helper (rows this form does
   *  not edit — other items, targeted rows — ride along), the
   *  edited items' target-less rows replaced by their drafts. */
  const saveValues = async (): Promise<boolean> => {
    if (itemDefs.length === 0 || valueRows === null) return true;
    const editedIds = new Set(itemDefs.map((d) => d.id));
    const values = (valueRows ?? [])
      .map((row) => eventValueInputOf(row, bootstrap))
      .filter((v): v is NonNullable<typeof v> => v !== null)
      .filter((v) => !(editedIds.has(v.itemDefinitionId) && v.target === null));
    for (const def of itemDefs) {
      const draft = valueDrafts[def.id] ?? { text: "", end: "" };
      const value = draftValueOf(def, draft);
      if (value === undefined) {
        setNotice(`「${def.name}」の値を確認してください`);
        return false;
      }
      if (value !== null) values.push({ itemDefinitionId: def.id, target: null, value });
    }
    try {
      await api.setEventValues({ subjectKind, subjectId: recordId, values });
      return true;
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        onUnauthorizedError();
        return false;
      }
      setNotice("予定は保存しました。追加項目だけ保存できなかったので、もう一度保存してください");
      return false;
    }
  };

  const validateTime = (sameDay: boolean): boolean => {
    if (time.mode === "clock") {
      if (!isValidTimeString(time.start)) {
        setNotice("開始時刻を HH:MM の形で入力してください");
        return false;
      }
      if (time.end !== "" && !isValidTimeString(time.end)) {
        setNotice("終了時刻を HH:MM の形で入力してください");
        return false;
      }
      if (sameDay && time.end !== "" && timeToMinutes(time.end) <= timeToMinutes(time.start)) {
        setNotice("終了は開始より後の時刻にしてください");
        return false;
      }
    }
    if (time.mode === "periods") {
      if (time.periodFrom === "" || time.periodTo === "") {
        setNotice("時限を選んでください");
        return false;
      }
      if (Number(time.periodTo) < Number(time.periodFrom)) {
        setNotice("終了時限が開始時限より前になっています");
        return false;
      }
    }
    return true;
  };

  const save = async (certaintyOverride?: string) => {
    if (busy) return;
    const finalCertainty = certaintyOverride ?? certainty;
    setNotice(null);

    if (subjectKind === "absence") {
      if (!staffId) {
        setNotice(`${template.personLabel}を選んでください`);
        return;
      }
      if (!fromDate || !toDate || toDate < fromDate) {
        setNotice("日付を確認してください（終了日が開始日より前になっています）");
        return;
      }
      if (!validateTime(fromDate === toDate)) return;
      setBusy(true);
      try {
        const result = await api.updateAbsence({
          id: recordId,
          revision: revisionOf(record) ?? 0,
          absence: {
            id: recordId,
            staffId,
            fromDate,
            toDate,
            time: calendarTimeOf(time, false),
            kind: stringField(record, "kind") ?? template.kindCode,
            certainty: finalCertainty,
            purpose: isLeaveAbsence ? (record["purpose"] ?? null) : purpose.trim() || null,
            note: note || null,
            subdivisionKey: subdivisionKey || null,
          },
        });
        setRecord(result.record);
        if (await saveValues()) {
          onSaved();
          onClose();
        } else {
          onSaved();
        }
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
      return;
    }

    if (provisional) {
      const text = provisionalText.trim();
      if (!text) {
        setNotice("名前または件名を入力してください");
        return;
      }
      if (!provisionalDate) {
        setNotice("日付を入力してください");
        return;
      }
      if (!validateTime(true)) return;
      setBusy(true);
      try {
        const base =
          freeTextNameOf(record) !== null
            ? { ...buildFreeTextEntry(text, provisional, provisionalDate), id: recordId }
            : { ...buildTitleOnlyEntry(text, provisional, provisionalDate), id: recordId };
        const result = await api.updateEvent({
          id: recordId,
          revision: revisionOf(record) ?? 0,
          event: {
            ...base,
            time: calendarTimeOf(time, record["time"] == null),
            description: description || null,
            visibility,
            certainty: finalCertainty,
          },
        });
        setRecord(result.record);
        if (await saveValues()) {
          onSaved();
          onClose();
        } else {
          onSaved();
        }
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
      return;
    }

    // A plain event.
    if (!title.trim()) {
      setNotice("件名を入力してください");
      return;
    }
    let nextStartsOn: string | null = null;
    let nextEndsOn: string | null = null;
    if (precision === "day") {
      if (!startsOn) {
        setNotice("日付を入力してください");
        return;
      }
      nextStartsOn = startsOn;
      nextEndsOn = startsOn;
    } else if (precision === "range") {
      if (!startsOn || !endsOn || endsOn < startsOn) {
        setNotice("日付を確認してください（終了日が開始日より前になっています）");
        return;
      }
      nextStartsOn = startsOn;
      nextEndsOn = endsOn;
    } else if (precision === "month") {
      if (!monthVal) {
        setNotice("対象月を選んでください");
        return;
      }
      const dayPart = (stringField(record, "startsOn") ?? "01").slice(8, 10) || "01";
      nextStartsOn = `${monthVal}-${dayPart}`;
      nextEndsOn = nextStartsOn;
    } else {
      const year = Number(schoolYear);
      if (!Number.isFinite(year) || year < 2000 || year > 2100) {
        setNotice("年度を確認してください");
        return;
      }
      nextStartsOn = `${year}-04-01`;
      nextEndsOn = null;
    }
    if (!validateTime(nextStartsOn !== null && nextStartsOn === nextEndsOn)) return;
    const location = locationText.trim();
    const matchedLocation = location
      ? bootstrap.locations.find((l) => normalizeName(l.name) === normalizeName(location))
      : undefined;
    const keptTargets = storedTargets.filter(
      (ref) => !offeredTargets.some((o) => o.key === refKey(ref)),
    );
    const chosenTargets = offeredTargets
      .filter((o) => targetKeys.includes(o.key))
      .map((o) => o.ref);
    setBusy(true);
    try {
      const result = await api.updateEvent({
        id: recordId,
        revision: revisionOf(record) ?? 0,
        event: {
          ...record,
          title: title.trim(),
          kind: chosenTemplate.kindCode,
          kindLabel: chosenTemplate.key === template.key ? (record["kindLabel"] ?? null) : null,
          datePrecision: precision,
          startsOn: nextStartsOn,
          endsOn: nextEndsOn,
          time: calendarTimeOf(time, record["time"] == null),
          locationId: matchedLocation?.id ?? null,
          locationText: matchedLocation ? null : location || null,
          description: description || null,
          certainty: finalCertainty,
          visibility,
          targets: [...keptTargets, ...chosenTargets],
          assignees,
        },
      });
      setRecord(result.record);
      if (await saveValues()) {
        onSaved();
        onClose();
      } else {
        onSaved();
      }
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const revision = revisionOf(record) ?? 0;
      if (subjectKind === "event") await api.deleteEvent({ id: recordId, revision });
      else await api.deleteAbsence({ id: recordId, revision });
      onSaved();
      onClose();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

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

  const certaintyField = (
    <div>
      <span className="detail-label">確定度</span>
      {isViewer ? (
        <p className="detail-static">{certainty === "tentative" ? "仮" : "確定"}</p>
      ) : (
        <select
          aria-label="確定度"
          value={certainty}
          onChange={(e) => setCertainty(e.target.value)}
        >
          <option value="tentative">仮</option>
          <option value="confirmed">確定</option>
        </select>
      )}
    </div>
  );

  const itemSection = itemDefs.length > 0 && (
    <>
      {itemDefs.map((def) => {
        const draft = valueDrafts[def.id] ?? { text: "", end: "" };
        const setDraft = (next: ItemDraft) =>
          setValueDrafts((current) => ({ ...current, [def.id]: next }));
        return (
          <div key={def.id}>
            <label className="detail-label" htmlFor={`detail-item-${def.id}`}>
              {def.name}
            </label>
            {def.valueType === "symbol" || def.valueType === "code" ? (
              <select
                id={`detail-item-${def.id}`}
                aria-label={def.name}
                value={draft.text}
                disabled={valueRows === null}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              >
                <option value="">（なし）</option>
                {def.options.map((o) => (
                  <option key={o.id} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : def.valueType === "boolean" ? (
              <select
                id={`detail-item-${def.id}`}
                aria-label={def.name}
                value={draft.text}
                disabled={valueRows === null}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              >
                <option value="">（なし）</option>
                <option value="true">○</option>
                <option value="false">×</option>
              </select>
            ) : def.valueType === "person" ? (
              <select
                id={`detail-item-${def.id}`}
                aria-label={def.name}
                value={draft.text}
                disabled={valueRows === null}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              >
                <option value="">（なし）</option>
                {bootstrap.masters.staff
                  .filter((s) => typeof s.name === "string")
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            ) : def.valueType === "time_range" ? (
              <span className="time-range-editor">
                <input
                  id={`detail-item-${def.id}`}
                  aria-label={`${def.name} 開始`}
                  value={draft.text}
                  placeholder="HH:MM"
                  disabled={valueRows === null}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                />
                <span>〜</span>
                <input
                  aria-label={`${def.name} 終了`}
                  value={draft.end}
                  placeholder="HH:MM"
                  disabled={valueRows === null}
                  onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                />
              </span>
            ) : (
              <input
                id={`detail-item-${def.id}`}
                aria-label={def.name}
                value={draft.text}
                inputMode={def.valueType === "number" ? "decimal" : undefined}
                placeholder={def.valueType === "time" ? "HH:MM" : undefined}
                disabled={valueRows === null}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              />
            )}
          </div>
        );
      })}
      {valuesFailed && (
        <p className="cell-notice" role="alert">
          追加項目を読み込めませんでした。追加項目は保存されません
        </p>
      )}
    </>
  );

  return (
    <div
      className="duty-panel-overlay"
      onClick={(e) => {
        // The modal renders inside the entry cell, whose table
        // cell activates on any click that reaches it: a click
        // inside the modal must not also start the cell's inline
        // editor behind the modal.
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="duty-panel detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="duty-panel-head">
          <h2>{heading}</h2>
          <button type="button" onClick={onClose}>
            閉じる
          </button>
        </div>

        <div className="detail-form">
          {subjectKind === "absence" ? (
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
                  onChange={(e) => setStaffId(e.target.value)}
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
                    onChange={(e) => setPurpose(e.target.value)}
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
                    onChange={(e) => setSubdivisionKey(e.target.value)}
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
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                </label>
                <label>
                  <span className="detail-label">終了日</span>
                  <input
                    type="date"
                    aria-label="終了日"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                  />
                </label>
              </div>
              <TimeEditor label="時間帯" state={time} periods={periods} onChange={setTime} />
              {itemSection}
              <div>
                <label className="detail-label" htmlFor="detail-note">
                  メモ
                </label>
                <textarea
                  id="detail-note"
                  aria-label="メモ"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              {certaintyField}
            </>
          ) : provisional ? (
            <>
              <p className="detail-note">
                仮の予定です。{template.personLabel}
                が決まったら、セルの再編集で名簿の名前に書き換えると不在として登録されます。
              </p>
              <div>
                <label className="detail-label" htmlFor="detail-provisional-text">
                  {freeTextNameOf(record) !== null ? `${template.personLabel}の名前` : "件名"}
                </label>
                <input
                  id="detail-provisional-text"
                  aria-label={
                    freeTextNameOf(record) !== null ? `${template.personLabel}の名前` : "件名"
                  }
                  value={provisionalText}
                  autoFocus
                  onChange={(e) => setProvisionalText(e.target.value)}
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
                  value={provisionalDate}
                  onChange={(e) => setProvisionalDate(e.target.value)}
                />
              </div>
              <TimeEditor label="時間" state={time} periods={periods} onChange={setTime} />
              {itemSection}
              <div>
                <label className="detail-label" htmlFor="detail-description">
                  メモ
                </label>
                <textarea
                  id="detail-description"
                  aria-label="メモ"
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="detail-grid">
                <div>
                  <span className="detail-label">公開範囲</span>
                  <select
                    aria-label="公開範囲"
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value)}
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
          ) : (
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
                  onChange={(e) => setTitle(e.target.value)}
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
                    onChange={(e) => setKindKey(e.target.value)}
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
                    onChange={(e) => setPrecision(e.target.value)}
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
                    onChange={(e) => {
                      setStartsOn(e.target.value);
                      setEndsOn(e.target.value);
                    }}
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
                      onChange={(e) => setStartsOn(e.target.value)}
                    />
                  </label>
                  <label>
                    <span className="detail-label">終了日</span>
                    <input
                      type="date"
                      aria-label="終了日"
                      value={endsOn}
                      onChange={(e) => setEndsOn(e.target.value)}
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
                    onChange={(e) => setMonthVal(e.target.value)}
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
                    onChange={(e) => setSchoolYear(e.target.value)}
                  />
                </div>
              )}
              {precision !== "month" && precision !== "undecided" && (
                <TimeEditor label="時間" state={time} periods={periods} onChange={setTime} />
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
                  onChange={(e) => setLocationText(e.target.value)}
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
                    <p className="detail-note">
                      未登録の場所です。テキストとして保存されます（§6.4）。
                    </p>
                  )}
              </div>
              <div>
                <span className="detail-label">{personLabel}（複数選択可・直接入力可）</span>
                <div className="detail-people">
                  {assignees.map((a, i) => (
                    <span key={i} className="detail-person">
                      {a.kind === "staff"
                        ? (bootstrap.masters.staff.find((s) => s.id === a.staffId)?.name ??
                          a.staffId)
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
              {itemSection}
              <div>
                <label className="detail-label" htmlFor="detail-description">
                  メモ
                </label>
                <textarea
                  id="detail-description"
                  aria-label="メモ"
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="detail-grid">
                <div>
                  <span className="detail-label">公開範囲</span>
                  <select
                    aria-label="公開範囲"
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value)}
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
          )}
        </div>

        {notice && (
          <p className="cell-notice" role="alert">
            {notice}
          </p>
        )}

        <div className="detail-actions">
          <button
            type="button"
            className="accent-button"
            disabled={busy}
            onClick={() => void save()}
          >
            保存する
          </button>
          {!isViewer && certainty === "tentative" && (
            <button type="button" disabled={busy} onClick={() => void save("confirmed")}>
              確定する
            </button>
          )}
          <button type="button" onClick={onClose}>
            閉じる
          </button>
          {confirmDelete ? (
            <span className="detail-delete-confirm">
              本当に削除しますか？
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() => void remove()}
              >
                削除する
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)}>
                やめる
              </button>
            </span>
          ) : (
            <button type="button" className="detail-delete" onClick={() => setConfirmDelete(true)}>
              この{subjectKind === "absence" ? "不在" : "予定"}を削除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
