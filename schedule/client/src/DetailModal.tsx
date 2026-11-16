import { useEffect, useState } from "react";
import { isValidTimeString, timeToMinutes } from "@school-manage/calendar-types";
import { ForbiddenError, UnauthorizedError, type ScheduleApi } from "./api";
import { buildFreeTextEntry, buildTitleOnlyEntry } from "./cells";
import { eventValueInputOf } from "./QuickPopover";
import { freeTextNameOf, normalizeName, provisionalLineText, schoolYearOf } from "./lib";
import type { BootstrapData, EventValueData, TargetRefData } from "./types";
import { AbsenceForm } from "./detail/AbsenceForm";
import { EventForm } from "./detail/EventForm";
import {
  ItemFields,
  draftOfRow,
  draftValueOf,
  itemDefsOf,
  type ItemDraft,
} from "./detail/ItemFields";
import { ProvisionalForm } from "./detail/ProvisionalForm";
import {
  assigneesOf,
  revisionOf,
  stringField,
  type Assignee,
  type DetailTarget,
} from "./detail/shared";
import { calendarTimeOf, periodChoicesOf, timeStateOf, type TimeState } from "./detail/TimeEditor";

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
 *
 * This file holds the modal's state and its save; the three
 * forms (absence / provisional / event), the time editor and the
 * additional items live under detail/, one file each.
 */

export type { DetailTarget } from "./detail/shared";

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

  // Esc closes the modal wherever the focus sits, as with the
  // quick-entry popover (PR #77): the dialog's own key handler
  // covers focus inside the modal, and this document-level one
  // covers the rest — a click on an empty part of the modal can
  // move focus out to the cell behind it (mousedown moves focus
  // even though the click itself is stopped), and Esc must still
  // close the modal from there. An Esc that cancels an IME
  // conversion is the conversion's, not the modal's.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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

  const itemFields = (
    <ItemFields
      defs={itemDefs}
      drafts={valueDrafts}
      onDraftChange={(defId, draft) =>
        setValueDrafts((current) => ({ ...current, [defId]: draft }))
      }
      valuesLoaded={valueRows !== null}
      valuesFailed={valuesFailed}
      bootstrap={bootstrap}
    />
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
        tabIndex={-1}
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
            <AbsenceForm
              template={template}
              bootstrap={bootstrap}
              staffId={staffId}
              onStaffIdChange={setStaffId}
              isLeaveAbsence={isLeaveAbsence}
              purpose={purpose}
              onPurposeChange={setPurpose}
              subdivisionOptions={subdivisionOptions}
              subdivisionKey={subdivisionKey}
              onSubdivisionKeyChange={setSubdivisionKey}
              fromDate={fromDate}
              onFromDateChange={setFromDate}
              toDate={toDate}
              onToDateChange={setToDate}
              time={time}
              periods={periods}
              onTimeChange={setTime}
              itemFields={itemFields}
              note={note}
              onNoteChange={setNote}
              certaintyField={certaintyField}
            />
          ) : provisional ? (
            <ProvisionalForm
              template={provisional}
              textLabel={freeTextNameOf(record) !== null ? `${template.personLabel}の名前` : "件名"}
              text={provisionalText}
              onTextChange={setProvisionalText}
              date={provisionalDate}
              onDateChange={setProvisionalDate}
              time={time}
              periods={periods}
              onTimeChange={setTime}
              itemFields={itemFields}
              description={description}
              onDescriptionChange={setDescription}
              visibility={visibility}
              onVisibilityChange={setVisibility}
              certaintyField={certaintyField}
            />
          ) : (
            <EventForm
              bootstrap={bootstrap}
              title={title}
              onTitleChange={setTitle}
              eventTemplates={eventTemplates}
              kindKey={kindKey}
              onKindKeyChange={setKindKey}
              precision={precision}
              onPrecisionChange={setPrecision}
              startsOn={startsOn}
              onStartsOnChange={setStartsOn}
              endsOn={endsOn}
              onEndsOnChange={setEndsOn}
              onDayDateChange={(value) => {
                setStartsOn(value);
                setEndsOn(value);
              }}
              monthVal={monthVal}
              onMonthValChange={setMonthVal}
              schoolYear={schoolYear}
              onSchoolYearChange={setSchoolYear}
              time={time}
              periods={periods}
              onTimeChange={setTime}
              locationText={locationText}
              onLocationTextChange={setLocationText}
              personLabel={personLabel}
              assignees={assignees}
              setAssignees={setAssignees}
              offeredTargets={offeredTargets}
              targetKeys={targetKeys}
              setTargetKeys={setTargetKeys}
              itemFields={itemFields}
              description={description}
              onDescriptionChange={setDescription}
              visibility={visibility}
              onVisibilityChange={setVisibility}
              certaintyField={certaintyField}
            />
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
