import { useEffect, useState } from "react";
import { isValidTimeString, timeToMinutes } from "@school-manage/calendar-types";
import { ForbiddenError, UnauthorizedError, type ScheduleApi } from "./api";
import {
  absenceLineText,
  axisEntries,
  columnLabel,
  dailyCellText,
  dailyValueForTarget,
  dailyValueText,
  eventTimeText,
  eventTitle,
  matchStaffByName,
  plainDailyValue,
  staffNameOf,
  targetRefForTarget,
  templateForKind,
} from "./lib";
import type {
  BootstrapData,
  DailyValueData,
  ItemDefinitionData,
  KindTemplateData,
  RangeDayData,
  TargetRefData,
  ViewColumnData,
} from "./types";

/**
 * The editable cells of the rows table (Issue #35): select a cell
 * and typing starts input — no double-click — and Enter saves one
 * entry (DESIGN schedule 6.1 / 6.2). Entry cells save through the
 * platform relay by kind template (6.3.1): an event kind takes the
 * typed text as its title; a trip / leave kind takes it as the
 * person's name, matched against the staff master, and a name that
 * matches nobody is kept as free text (see buildFreeTextEntry).
 * Daily-value cells follow the item's value type (6.2-6). A failed
 * save never loses the typed text: the draft stays in the cell with
 * a notice, and a 403 puts the display back as it was.
 *
 * Which entries a column holds follows the data the view already
 * has: view columns carry no per-column kind binding in this
 * implementation, so the event_category column is the general entry
 * cell — every kind template is choosable in it, and the day's
 * events and absences both show as its entries. An event_list item
 * column is bound to the kind template of the item's own key (the
 * 〆切 column to the deadline template, the 職員動静 column to the
 * absence kinds), which is how the presets already name them.
 */
export interface CellEditorContext {
  api: ScheduleApi;
  /** A write landed: the app re-reads the range. */
  onSaved(): void;
  /** A write met a 401: the app sends the person to login. */
  onUnauthorizedError(): void;
}

interface CellProps {
  day: RangeDayData;
  column: ViewColumnData;
  bootstrap: BootstrapData;
  editor: CellEditorContext;
  active: boolean;
  /** The character typed on the cell itself, seeding the draft. */
  seedText: string | null;
  onActivate(): void;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function revisionOf(record: Record<string, unknown>): number | null {
  const value = record["revision"];
  return typeof value === "number" ? value : null;
}

let fallbackSeq = 0;
/** New platform records carry a client-made id (the platform's
 *  input schemas require one). */
function newEntryId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
  fallbackSeq += 1;
  return `entry-${Date.now()}-${fallbackSeq}`;
}

/** The notice a failed save leaves in the cell. A 403 means the
 *  display goes back to what the server holds (Issue #35). */
function saveFailureNotice(cause: unknown): string {
  if (cause instanceof ForbiddenError) return "権限がありません。元の表示に戻しました";
  if (cause instanceof Error && cause.message) return `保存できませんでした：${cause.message}`;
  return "保存できませんでした";
}

// ---- entry cells ---------------------------------------------------

interface EntryPlan {
  templates: KindTemplateData[];
  primary: KindTemplateData | null;
  events: Record<string, unknown>[];
  absences: Record<string, unknown>[];
}

/** Which entries a column shows and which kinds can be added, per
 *  the module comment above. Null when the column is no entry
 *  column (the caller falls back to the daily-value cell). */
function entryPlan(
  day: RangeDayData,
  column: ViewColumnData,
  bootstrap: BootstrapData,
): EntryPlan | null {
  const templates = bootstrap.kindTemplates;
  if (column.sourceKind === "event_category") {
    return {
      templates,
      primary: templateForKind(bootstrap, "event", "event") ?? templates[0] ?? null,
      events: day.events,
      absences: day.absences,
    };
  }
  const item = bootstrap.itemDefinitions.find((i) => i.id === column.itemDefinitionId);
  if (!item || item.valueType !== "event_list") return null;
  if (item.key === "staff_movement") {
    // 職員動静 is the staff-only bundle of trips, training and leave
    // (DESIGN schedule 5.2 scenario 8): its entries are absences.
    const absenceTemplates = templates.filter((t) => t.subjectKind === "absence");
    return {
      templates: absenceTemplates,
      primary:
        templateForKind(bootstrap, "absence", "business_trip") ?? absenceTemplates[0] ?? null,
      events: [],
      absences: day.absences,
    };
  }
  const bound = templates.find((t) => t.key === item.key || t.kindCode === item.key) ?? null;
  if (bound) {
    return {
      templates: [bound],
      primary: bound,
      events:
        bound.subjectKind === "event" ? day.events.filter((e) => e["kind"] === bound.kindCode) : [],
      absences:
        bound.subjectKind === "absence"
          ? day.absences.filter((a) => a["kind"] === bound.kindCode)
          : [],
    };
  }
  const eventTemplate = templateForKind(bootstrap, "event", "event");
  return {
    templates: eventTemplate ? [eventTemplate] : [],
    primary: eventTemplate,
    events: day.events.filter((e) => e["kind"] === "event"),
    absences: [],
  };
}

function buildEventRecord(
  title: string,
  template: KindTemplateData,
  date: string,
): Record<string, unknown> {
  return {
    id: newEntryId(),
    title,
    kind: template.kindCode,
    kindLabel: null,
    datePrecision: "day",
    startsOn: date,
    endsOn: date,
    time: null,
    locationId: null,
    locationText: null,
    description: null,
    certainty: "confirmed",
    visibility: "staff_only",
    targets: [],
    impacts: [],
    assignees: [],
  };
}

function buildAbsenceRecord(
  staffId: string,
  template: KindTemplateData,
  date: string,
  role: string,
): Record<string, unknown> {
  return {
    id: newEntryId(),
    staffId,
    fromDate: date,
    toDate: date,
    time: { kind: "all_day" },
    kind: template.kindCode,
    // A Viewer's own trip / leave is saved as tentative; the
    // platform enforces the same rule on its side (連携5).
    certainty: role === "Viewer" ? "tentative" : "confirmed",
    purpose: null,
    note: null,
    subdivisionKey: null,
  };
}

/**
 * A typed name that matches no staff member is kept as free text
 * (DESIGN schedule 6.3.1): absences name a real staff member, so
 * the holding shape this data model has for a person who is not on
 * the roster is an event whose assignees carry the name as free
 * text (4.5), titled the way 6.3.1 prescribes for the kind — the
 * person's name with the classification — which is also how the
 * cell line reads.
 */
function buildFreeTextEntry(
  name: string,
  template: KindTemplateData,
  date: string,
): Record<string, unknown> {
  return {
    ...buildEventRecord(`${name}（${template.name}）`, { ...template, kindCode: "other" }, date),
    kindLabel: template.name,
    certainty: "tentative",
    assignees: [{ kind: "free_text", name, role: template.personLabel }],
  };
}

export function EntryCell({ day, column, bootstrap, editor, active, seedText }: CellProps) {
  const plan = entryPlan(day, column, bootstrap);
  const isViewer = bootstrap.role === "Viewer";
  // A Viewer starts input only for their own trips and leave
  // (Issue #35): on a Viewer's screen the event kinds are not
  // offered at all, and neither are other people's absences below.
  const templates = isViewer
    ? (plan?.templates ?? []).filter((t) => t.subjectKind === "absence")
    : (plan?.templates ?? []);
  const primary = templates.find((t) => t.key === plan?.primary?.key) ?? templates[0] ?? null;

  const [kindKey, setKindKey] = useState<string | null>(null);
  const template = templates.find((t) => t.key === kindKey) ?? primary;
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only the arriving seed matters; the draft is the person's own
  // from then on, so the effect keys on the seed alone.
  useEffect(() => {
    if (seedText && draft === "") setDraft(seedText);
  }, [seedText]);

  useEffect(() => {
    // A Viewer's absence input is their own name from the start.
    if (active && isViewer && template?.subjectKind === "absence" && draft === "") {
      const own = bootstrap.masters.staff.find((s) => s.id === bootstrap.teacherId);
      if (own?.name) setDraft(own.name);
    }
  }, [active, template?.key]);

  if (!plan) return <>{dailyCellText(day, column, bootstrap)}</>;

  const fail = (cause: unknown) => {
    if (cause instanceof UnauthorizedError) {
      editor.onUnauthorizedError();
      return;
    }
    setNotice(saveFailureNotice(cause));
  };

  const submitNew = async () => {
    const text = draft.trim();
    if (!text || !template || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (template.subjectKind === "event") {
        await editor.api.createEvent({ event: buildEventRecord(text, template, day.date) });
      } else {
        const matched = matchStaffByName(text, bootstrap.masters.staff);
        if (isViewer && (!matched || matched.id !== bootstrap.teacherId)) {
          setNotice("自分の出張・休暇だけ登録できます");
          return;
        }
        if (matched) {
          await editor.api.createAbsence({
            absence: buildAbsenceRecord(matched.id, template, day.date, bootstrap.role),
          });
        } else {
          await editor.api.createEvent({ event: buildFreeTextEntry(text, template, day.date) });
        }
      }
      // The draft clears only once the entry stands, so the cell is
      // ready for the next one; a failure keeps the text (below).
      setDraft("");
      editor.onSaved();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const submitEditEvent = async (event: Record<string, unknown>) => {
    const id = stringField(event, "id");
    const revision = revisionOf(event);
    const title = editDraft.trim();
    if (!id || revision === null || !title || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await editor.api.updateEvent({ id, revision, event: { ...event, title } });
      setEditingId(null);
      editor.onSaved();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const submitEditAbsence = async (absence: Record<string, unknown>) => {
    const id = stringField(absence, "id");
    const revision = revisionOf(absence);
    if (!id || revision === null || busy) return;
    const matched = matchStaffByName(editDraft, bootstrap.masters.staff);
    if (!matched) {
      // An absence names a roster member; a name that matches
      // nobody cannot become its holder, so the edit stays open.
      setNotice(`名簿に一致する教職員がいません：${editDraft.trim()}`);
      return;
    }
    if (isViewer && matched.id !== bootstrap.teacherId) {
      setNotice("自分の出張・休暇だけ変更できます");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await editor.api.updateAbsence({
        id,
        revision,
        absence: {
          id,
          staffId: matched.id,
          fromDate: stringField(absence, "fromDate") ?? day.date,
          toDate: stringField(absence, "toDate") ?? day.date,
          time: absence["time"] ?? { kind: "all_day" },
          kind: stringField(absence, "kind") ?? "",
          certainty: stringField(absence, "certainty") ?? "confirmed",
          purpose: absence["purpose"] ?? null,
          note: absence["note"] ?? null,
          subdivisionKey: absence["subdivisionKey"] ?? null,
        },
      });
      setEditingId(null);
      editor.onSaved();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const removeEntry = async (subjectKind: "event" | "absence", record: Record<string, unknown>) => {
    const id = stringField(record, "id");
    const revision = revisionOf(record);
    if (!id || revision === null || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (subjectKind === "event") await editor.api.deleteEvent({ id, revision });
      else await editor.api.deleteAbsence({ id, revision });
      editor.onSaved();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  /** Whether this caller may change one entry: Admin and Editor
   *  may; a Viewer only their own absences. */
  const canChange = (subjectKind: "event" | "absence", record: Record<string, unknown>) => {
    if (revisionOf(record) === null) return false;
    if (!isViewer) return true;
    return subjectKind === "absence" && record["staffId"] === bootstrap.teacherId;
  };

  const renderLine = (
    subjectKind: "event" | "absence",
    record: Record<string, unknown>,
    text: string,
  ) => {
    const id = stringField(record, "id") ?? text;
    const changeable = canChange(subjectKind, record);
    // Re-editing an absence rewrites its holder from the typed
    // name, so it is offered only when the record carries the full
    // shape; the restricted shape (another person's leave, PR #64)
    // would lose its hidden texts to a rewrite from what is shown.
    const editable = changeable && (subjectKind === "event" || "purpose" in record);
    if (editingId === id) {
      return (
        <li key={id} className="entry-line editing">
          <input
            aria-label="予定の再編集"
            value={editDraft}
            disabled={busy}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void (subjectKind === "event"
                  ? submitEditEvent(record)
                  : submitEditAbsence(record));
              }
              if (e.key === "Escape") setEditingId(null);
            }}
          />
          <button type="button" onClick={() => setEditingId(null)}>
            取消
          </button>
        </li>
      );
    }
    return (
      <li key={id} className="entry-line">
        <span className="entry-text">{text}</span>
        {changeable && (
          <span className="entry-actions">
            {editable && (
              <button
                type="button"
                aria-label={`${text}を編集`}
                onClick={() => {
                  setNotice(null);
                  setEditingId(id);
                  setEditDraft(
                    subjectKind === "event"
                      ? eventTitle(record)
                      : staffNameOf(bootstrap, stringField(record, "staffId") ?? ""),
                  );
                }}
              >
                編集
              </button>
            )}
            <button
              type="button"
              aria-label={`${text}を削除`}
              onClick={() => void removeEntry(subjectKind, record)}
            >
              削除
            </button>
          </span>
        )}
      </li>
    );
  };

  return (
    <div className="entry-cell">
      <ul className="entry-list">
        {plan.events.map((event) =>
          renderLine("event", event, `${eventTimeText(event)}${eventTitle(event)}`),
        )}
        {plan.absences.map((absence) =>
          renderLine("absence", absence, absenceLineText(absence, bootstrap)),
        )}
      </ul>
      {active && template && (
        <div className="entry-editor">
          {templates.length > 1 && (
            <div className="kind-chips" role="group" aria-label="種別">
              {templates.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={t.key === template.key}
                  className={t.key === template.key ? "chip selected" : "chip"}
                  onClick={() => setKindKey(t.key)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <input
            aria-label={`${columnLabel(column, bootstrap)}の入力（${day.date}）`}
            value={draft}
            disabled={busy}
            placeholder={
              template.subjectKind === "absence" ? `${template.personLabel}の名前` : "件名"
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitNew();
              }
            }}
          />
        </div>
      )}
      {notice && (
        <p className="cell-notice" role="alert">
          {notice}
        </p>
      )}
    </div>
  );
}

// ---- daily-value cells ----------------------------------------------

export function DailyCell({ day, column, bootstrap, editor, active, seedText }: CellProps) {
  const item = bootstrap.itemDefinitions.find((i) => i.id === column.itemDefinitionId);
  const [notice, setNotice] = useState<string | null>(null);
  if (!item) return <>{dailyCellText(day, column, bootstrap)}</>;
  // daily.write is Admin and Editor only (DESIGN-AUTH-TENANCY 4.4):
  // without it the cell never starts input — a Viewer's screen
  // stays the read-only table.
  if (!bootstrap.permissions.includes("daily.write") || !active) {
    return <>{dailyCellText(day, column, bootstrap)}</>;
  }

  /** Runs one write; true when it landed. A failure leaves the
   *  caller's draft or selection to put back, with the notice set. */
  const runWrite = async (write: () => Promise<unknown>): Promise<boolean> => {
    setNotice(null);
    try {
      await write();
      editor.onSaved();
      return true;
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        editor.onUnauthorizedError();
        return false;
      }
      setNotice(saveFailureNotice(cause));
      return false;
    }
  };

  const save = (target: TargetRefData | null, value: unknown) =>
    runWrite(() =>
      editor.api.setDailyValue({ date: day.date, itemDefinitionId: item.id, target, value }),
    );
  const clear = (target: TargetRefData | null) =>
    runWrite(() =>
      editor.api.deleteDailyValue({ date: day.date, itemDefinitionId: item.id, target }),
    );

  const entries = axisEntries(item, bootstrap);
  const hasAxis =
    (item.targetGroupId !== null || item.targetPlatformAxis !== null) && entries.length > 0;

  return (
    <div className="daily-cell">
      {hasAxis ? (
        entries.map((entry) => (
          <div key={entry.id} className="daily-editor-row">
            <span className="daily-target-name">{entry.name}</span>
            <DailyValueControl
              item={item}
              value={dailyValueForTarget(day, item, entry.id)}
              label={`${item.name}（${entry.name}）`}
              people={bootstrap.masters.staff}
              save={(value) => save(targetRefForTarget(item, bootstrap, entry.id), value)}
              clear={() => clear(targetRefForTarget(item, bootstrap, entry.id))}
              onNotice={setNotice}
            />
          </div>
        ))
      ) : (
        <DailyValueControl
          item={item}
          value={plainDailyValue(day, item)}
          label={item.name}
          seedText={seedText}
          people={bootstrap.masters.staff}
          save={(value) => save(null, value)}
          clear={() => clear(null)}
          onNotice={setNotice}
        />
      )}
      {notice && (
        <p className="cell-notice" role="alert">
          {notice}
        </p>
      )}
    </div>
  );
}

interface ControlProps {
  item: ItemDefinitionData;
  value: DailyValueData | undefined;
  label: string;
  seedText?: string | null;
  /** The staff roster, for person values. */
  people: BootstrapData["masters"]["staff"];
  save(value: unknown): Promise<boolean>;
  clear(): Promise<boolean>;
  onNotice(message: string | null): void;
}

/**
 * One value's editor, shaped by the item's value type (DESIGN
 * schedule 6.2-6): a symbol is chosen, a time is typed, a person is
 * chosen from the roster. Enter commits the typed kinds; a choice
 * commits on change. Types the presets do not use for direct cell
 * input (persons lists, per-target time maps) stay read-only text.
 */
function DailyValueControl({
  item,
  value,
  label,
  seedText,
  people,
  save,
  clear,
  onNotice,
}: ControlProps) {
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [draftEnd, setDraftEnd] = useState<string | null>(null);

  const currentSelect =
    item.valueType === "symbol" || item.valueType === "code"
      ? (item.options.find((o) => o.id === value?.valueOptionId)?.code ?? "")
      : item.valueType === "boolean"
        ? value?.valueBoolean === null || value?.valueBoolean === undefined
          ? ""
          : String(value.valueBoolean)
        : item.valueType === "person"
          ? (value?.valuePersonId ?? "")
          : "";
  const selectValue = sel ?? currentSelect;

  const onSelect = async (next: string) => {
    setSel(next);
    const ok =
      next === ""
        ? value
          ? await clear()
          : true
        : await save(item.valueType === "boolean" ? next === "true" : next);
    if (!ok) setSel(currentSelect);
  };

  if (item.valueType === "symbol" || item.valueType === "code") {
    return (
      <select
        aria-label={label}
        value={selectValue}
        onChange={(e) => void onSelect(e.target.value)}
      >
        <option value="">（なし）</option>
        {item.options.map((o) => (
          <option key={o.id} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (item.valueType === "boolean") {
    return (
      <select
        aria-label={label}
        value={selectValue}
        onChange={(e) => void onSelect(e.target.value)}
      >
        <option value="">（なし）</option>
        <option value="true">○</option>
        <option value="false">×</option>
      </select>
    );
  }
  if (item.valueType === "person") {
    return (
      <select
        aria-label={label}
        value={selectValue}
        onChange={(e) => void onSelect(e.target.value)}
      >
        <option value="">（なし）</option>
        {people
          .filter((p) => typeof p.name === "string")
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </select>
    );
  }

  const text = draft ?? value?.valueText ?? seedText ?? "";
  const time = draft ?? value?.valueTime ?? seedText ?? "";
  const timeEnd = draftEnd ?? value?.valueTimeEnd ?? "";
  const number =
    draft ??
    (value?.valueNumber !== null && value?.valueNumber !== undefined
      ? String(value.valueNumber)
      : "") ??
    "";

  const commitText = async () => {
    const next = text.trim();
    if (next === "") {
      if (value) await clear();
      return;
    }
    await save(next);
  };
  const commitTime = async () => {
    const next = time.trim();
    if (next === "") {
      if (value) await clear();
      return;
    }
    if (!isValidTimeString(next)) {
      onNotice("時刻は HH:MM の形で入力してください");
      return;
    }
    onNotice(null);
    await save(next);
  };
  const commitRange = async () => {
    const startsAt = time.trim();
    const endsAt = timeEnd.trim();
    if (!isValidTimeString(startsAt) || !isValidTimeString(endsAt)) {
      onNotice("時刻は HH:MM の形で入力してください");
      return;
    }
    if (timeToMinutes(endsAt) <= timeToMinutes(startsAt)) {
      onNotice("終了は開始より後の時刻にしてください");
      return;
    }
    onNotice(null);
    await save({ startsAt, endsAt });
  };
  const commitNumber = async () => {
    const next = number.trim();
    if (next === "") {
      if (value) await clear();
      return;
    }
    const parsed = Number(next);
    if (!Number.isFinite(parsed)) {
      onNotice("数値で入力してください");
      return;
    }
    onNotice(null);
    await save(parsed);
  };

  if (item.valueType === "time") {
    return (
      <input
        aria-label={label}
        value={time}
        placeholder="HH:MM"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commitTime();
          }
        }}
      />
    );
  }
  if (item.valueType === "time_range") {
    return (
      <span className="time-range-editor">
        <input
          aria-label={`${label} 開始`}
          value={time}
          placeholder="HH:MM"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitRange();
            }
          }}
        />
        <span>〜</span>
        <input
          aria-label={`${label} 終了`}
          value={timeEnd}
          placeholder="HH:MM"
          onChange={(e) => setDraftEnd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitRange();
            }
          }}
        />
      </span>
    );
  }
  if (item.valueType === "number") {
    return (
      <input
        aria-label={label}
        value={number}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commitNumber();
          }
        }}
      />
    );
  }
  if (item.valueType === "text") {
    return (
      <input
        aria-label={label}
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commitText();
          }
        }}
      />
    );
  }
  // persons / target_time_map / event_list (handled by EntryCell):
  // no direct cell editor in this issue; the value stays readable.
  return <>{value ? dailyValueText(value, item) : ""}</>;
}
