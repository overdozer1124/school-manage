import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
  freeTextNameOf,
  matchStaffByName,
  plainDailyValue,
  provisionalLineText,
  provisionalTemplateOf,
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
 *
 * A trip or leave whose person is not settled yet — a placeholder
 * name, or a trip known only by its title — is a provisional
 * entry: an event carrying the absence template's name as its
 * kindLabel (lib's provisionalTemplateOf). It lives in its kind's
 * column, read exactly as typed, and the event column leaves it
 * there when the view has that column; in a view without one it
 * keeps showing in the event column, as it did before. Rewriting
 * a provisional entry with a roster name turns it into a real
 * absence (PR #75 review, 推奨 3; Araki's cases, 2026-11-16).
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

/**
 * Whether a keydown belongs to an IME rather than to the cell: a
 * conversion in progress reports key "Process", isComposing, or
 * the legacy keyCode 229. Such a keystroke must not seed a draft —
 * the romaji would stick as its first character while the rest
 * converts in the input — and its Enter confirms the conversion
 * instead of saving (PR #75 review).
 */
export function isImeKeyEvent(e: ReactKeyboardEvent): boolean {
  return e.key === "Process" || e.nativeEvent.isComposing || e.keyCode === 229;
}

/** Enter saves a cell's input only when it is a plain Enter, not
 *  the Enter that confirms an IME conversion. Every Enter handler
 *  in the cells goes through this one check. */
export function isCommitEnter(e: ReactKeyboardEvent): boolean {
  return e.key === "Enter" && !isImeKeyEvent(e);
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
  /** An absence-family column （職員動静, or a column bound to a
   *  trip / leave template): its provisional entries read as
   *  typed, without the event title's kind suffix. */
  absenceFamily: boolean;
}

/** The absence templates whose provisional entries a sibling
 *  column of the same view claims as its own: a 職員動静 column
 *  claims every absence kind, a column bound to one absence
 *  template claims that kind. The event column leaves a claimed
 *  provisional to its own column — no double display — and keeps
 *  showing it when no column of the view claims it. */
function claimedProvisionalLabels(column: ViewColumnData, bootstrap: BootstrapData): Set<string> {
  const claimed = new Set<string>();
  const view = bootstrap.views.find((v) => v.id === column.viewDefinitionId);
  if (!view) return claimed;
  for (const sibling of view.columns) {
    if (sibling.id === column.id || sibling.sourceKind !== "daily_item") continue;
    const item = bootstrap.itemDefinitions.find((i) => i.id === sibling.itemDefinitionId);
    if (!item || item.valueType !== "event_list") continue;
    if (item.key === "staff_movement") {
      for (const t of bootstrap.kindTemplates) {
        if (t.subjectKind === "absence") claimed.add(t.name);
      }
      continue;
    }
    const bound =
      bootstrap.kindTemplates.find((t) => t.key === item.key || t.kindCode === item.key) ?? null;
    if (bound?.subjectKind === "absence") claimed.add(bound.name);
  }
  return claimed;
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
    const claimed = claimedProvisionalLabels(column, bootstrap);
    return {
      templates,
      primary: templateForKind(bootstrap, "event", "event") ?? templates[0] ?? null,
      events: day.events.filter((e) => {
        const provisional = provisionalTemplateOf(e, bootstrap);
        return !provisional || !claimed.has(provisional.name);
      }),
      absences: day.absences,
      absenceFamily: false,
    };
  }
  const item = bootstrap.itemDefinitions.find((i) => i.id === column.itemDefinitionId);
  if (!item || item.valueType !== "event_list") return null;
  if (item.key === "staff_movement") {
    // 職員動静 is the staff-only bundle of trips, training and leave
    // (DESIGN schedule 5.2 scenario 8): its entries are absences,
    // together with the provisional entries of every absence kind.
    const absenceTemplates = templates.filter((t) => t.subjectKind === "absence");
    return {
      templates: absenceTemplates,
      primary:
        templateForKind(bootstrap, "absence", "business_trip") ?? absenceTemplates[0] ?? null,
      events: day.events.filter((e) => provisionalTemplateOf(e, bootstrap) !== null),
      absences: day.absences,
      absenceFamily: true,
    };
  }
  const bound = templates.find((t) => t.key === item.key || t.kindCode === item.key) ?? null;
  if (bound) {
    return {
      templates: [bound],
      primary: bound,
      events:
        bound.subjectKind === "event"
          ? day.events.filter((e) => e["kind"] === bound.kindCode)
          : day.events.filter((e) => provisionalTemplateOf(e, bootstrap)?.key === bound.key),
      absences:
        bound.subjectKind === "absence"
          ? day.absences.filter((a) => a["kind"] === bound.kindCode)
          : [],
      absenceFamily: bound.subjectKind === "absence",
    };
  }
  const eventTemplate = templateForKind(bootstrap, "event", "event");
  return {
    templates: eventTemplate ? [eventTemplate] : [],
    primary: eventTemplate,
    events: day.events.filter((e) => e["kind"] === "event"),
    absences: [],
    absenceFamily: false,
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
  purpose: string | null = null,
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
    purpose,
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

/**
 * A trip known only by its title — the person is not decided
 * yet, or the trip involves nearly the whole staff and the names
 * are not written out (Araki's cases, 2026-11-16): the same
 * provisional shape as a placeholder name, but with no free-text
 * person, so the title itself is what its column shows. The kind
 * templates have no title step (their steps are the person, the
 * location, the time and the kind's own step), so the title
 * stays the event's own title field, and the cell's absence
 * input offers it as the 「件名のみ」 mode beside the person's
 * name.
 */
function buildTitleOnlyEntry(
  title: string,
  template: KindTemplateData,
  date: string,
): Record<string, unknown> {
  return {
    ...buildEventRecord(title, { ...template, kindCode: "other" }, date),
    kindLabel: template.name,
    certainty: "tentative",
    assignees: [],
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
  // An absence kind takes either the person's name (the usual
  // reading of the typed text) or, in the 「件名のみ」 mode, a
  // title with nobody attached yet (buildTitleOnlyEntry).
  const [inputMode, setInputMode] = useState<"person" | "title">("person");
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
    if (
      active &&
      isViewer &&
      inputMode === "person" &&
      template?.subjectKind === "absence" &&
      draft === ""
    ) {
      const own = bootstrap.masters.staff.find((s) => s.id === bootstrap.teacherId);
      if (own?.name) setDraft(own.name);
    }
  }, [active, template?.key, inputMode]);

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
      } else if (inputMode === "title") {
        // A title-only entry is held as an event, which a Viewer
        // may not create: their absence input is their own name.
        if (isViewer) {
          setNotice("自分の出張・休暇だけ登録できます");
          return;
        }
        await editor.api.createEvent({ event: buildTitleOnlyEntry(text, template, day.date) });
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
    const provisional = provisionalTemplateOf(event, bootstrap);
    if (provisional) {
      const matched = matchStaffByName(title, bootstrap.masters.staff);
      if (matched) {
        if (isViewer && matched.id !== bootstrap.teacherId) {
          setNotice("自分の出張・休暇だけ変更できます");
          return;
        }
        // The placeholder gives way to the real person: the
        // entry is registered as a platform absence — and so
        // joins duty-conflict derivation — and the provisional
        // event goes away. A title-only trip keeps its title as
        // the absence's purpose where the kind reads person and
        // title together (a placeholder name was never a title,
        // so it leaves no purpose).
        setBusy(true);
        setNotice(null);
        try {
          await editor.api.createAbsence({
            absence: buildAbsenceRecord(
              matched.id,
              provisional,
              stringField(event, "startsOn") ?? day.date,
              bootstrap.role,
              freeTextNameOf(event) === null && provisional.displaySource === "person_title"
                ? eventTitle(event)
                : null,
            ),
          });
          await editor.api.deleteEvent({ id, revision });
          setEditingId(null);
          editor.onSaved();
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy(false);
        }
        return;
      }
      // Still provisional: a placeholder name is rewritten under
      // the new name; a title-only entry takes the new title.
      setBusy(true);
      setNotice(null);
      try {
        const next =
          freeTextNameOf(event) !== null
            ? {
                ...buildFreeTextEntry(
                  title,
                  provisional,
                  stringField(event, "startsOn") ?? day.date,
                ),
                id,
              }
            : { ...event, title };
        await editor.api.updateEvent({ id, revision, event: next });
        setEditingId(null);
        editor.onSaved();
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
      return;
    }
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
            autoFocus
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (isCommitEnter(e)) {
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
                      ? provisionalTemplateOf(record, bootstrap)
                        ? provisionalLineText(record)
                        : eventTitle(record)
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
          renderLine(
            "event",
            event,
            `${eventTimeText(event)}${
              plan.absenceFamily && provisionalTemplateOf(event, bootstrap)
                ? provisionalLineText(event)
                : eventTitle(event)
            }`,
          ),
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
                  onClick={() => {
                    setKindKey(t.key);
                    setInputMode("person");
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {template.subjectKind === "absence" && (
            <div className="kind-chips" role="group" aria-label="入力の種類">
              <button
                type="button"
                aria-pressed={inputMode === "person"}
                className={inputMode === "person" ? "chip selected" : "chip"}
                onClick={() => setInputMode("person")}
              >
                {template.personLabel}の名前
              </button>
              <button
                type="button"
                aria-pressed={inputMode === "title"}
                className={inputMode === "title" ? "chip selected" : "chip"}
                onClick={() => setInputMode("title")}
              >
                件名のみ
              </button>
            </div>
          )}
          <input
            aria-label={`${columnLabel(column, bootstrap)}の入力（${day.date}）`}
            value={draft}
            disabled={busy}
            autoFocus
            placeholder={
              template.subjectKind === "absence"
                ? inputMode === "title"
                  ? "件名"
                  : `${template.personLabel}の名前`
                : "件名"
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (isCommitEnter(e)) {
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
        entries.map((entry, index) => (
          <div key={entry.id} className="daily-editor-row">
            <span className="daily-target-name">{entry.name}</span>
            <DailyValueControl
              item={item}
              value={dailyValueForTarget(day, item, entry.id)}
              label={`${item.name}（${entry.name}）`}
              autoFocus={index === 0}
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
          autoFocus
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
  /** Focus this control when the cell opens, so typing after the
   *  click or the seeding keystroke lands in it (PR #75 review). */
  autoFocus?: boolean;
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
  autoFocus,
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
        autoFocus={autoFocus}
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
        autoFocus={autoFocus}
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
        autoFocus={autoFocus}
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

  // A landed write hands the display back to the server value:
  // the draft clears, so a value another person saves later is
  // what the next read shows, not this stale text (PR #75 review).
  const commitText = async () => {
    const next = text.trim();
    if (next === "") {
      if (value && (await clear())) setDraft(null);
      return;
    }
    if (await save(next)) setDraft(null);
  };
  const commitTime = async () => {
    const next = time.trim();
    if (next === "") {
      if (value && (await clear())) setDraft(null);
      return;
    }
    if (!isValidTimeString(next)) {
      onNotice("時刻は HH:MM の形で入力してください");
      return;
    }
    onNotice(null);
    if (await save(next)) setDraft(null);
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
    if (await save({ startsAt, endsAt })) {
      setDraft(null);
      setDraftEnd(null);
    }
  };
  const commitNumber = async () => {
    const next = number.trim();
    if (next === "") {
      if (value && (await clear())) setDraft(null);
      return;
    }
    const parsed = Number(next);
    if (!Number.isFinite(parsed)) {
      onNotice("数値で入力してください");
      return;
    }
    onNotice(null);
    if (await save(parsed)) setDraft(null);
  };

  if (item.valueType === "time") {
    return (
      <input
        aria-label={label}
        value={time}
        placeholder="HH:MM"
        autoFocus={autoFocus}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isCommitEnter(e)) {
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
          autoFocus={autoFocus}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (isCommitEnter(e)) {
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
            if (isCommitEnter(e)) {
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
        autoFocus={autoFocus}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isCommitEnter(e)) {
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
        autoFocus={autoFocus}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isCommitEnter(e)) {
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
