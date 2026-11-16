import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { isValidTimeString, timeToMinutes } from "@school-manage/calendar-types";
import { ForbiddenError, UnauthorizedError, type ScheduleApi } from "./api";
import { isCommitEnter } from "./cells";
import { ClockPicker } from "./ClockPicker";
import { absenceLineText, eventTitle, matchStaffByName, normalizeName } from "./lib";
import type {
  BootstrapData,
  EventValueData,
  ItemDefinitionData,
  KindTemplateData,
  TargetRefData,
} from "./types";

/**
 * The quick-entry popover (Issue #36; DESIGN schedule 6.5): when
 * Enter lands an entry in a cell, this opens beside it and walks
 * the kind template's steps — the person, the place, the time,
 * the kind's own step — one at a time, in the template's order.
 * Every step saves the moment it is confirmed, so closing the
 * popover halfway (Esc, an outside click, moving to another cell)
 * loses nothing that was confirmed; a step's unconfirmed edits
 * are the only thing a close discards. Step headings are buttons
 * and jump straight to their step, saving the current step first
 * when it has unsaved changes.
 *
 * Which steps a kind has is the template's business (6.3.1 /
 * 6.5): the leave kind takes the subdivision step in place of the
 * location step. Two steps can fall away for data reasons, and
 * say so by their absence: an item step the school has not bound
 * to an item definition yet (the deadline default), and the
 * location step of an absence kind — a platform absence carries
 * no location field, so there is nowhere for the value to land
 * until a home for it is decided. A subdivision step whose kind
 * has no subdivisions defined falls away the same way.
 *
 * Provisional entries (a placeholder name, a title-only trip)
 * never open this popover: their person is not settled, and the
 * steps exist to detail a settled entry (cells.tsx decides).
 */

export interface QuickPopoverTarget {
  subjectKind: "event" | "absence";
  template: KindTemplateData;
  record: Record<string, unknown>;
}

interface PopStep {
  kind: "person" | "location" | "subdivision" | "item" | "time";
  label: string;
  itemDefinitionId: string | null;
}

type Assignee =
  | { kind: "staff"; staffId: string; role: string | null }
  | { kind: "free_text"; name: string; role: string | null };

/** A value settled by the very keystroke or click that confirms
 *  a step — a highlighted suggestion, a subdivision button, a
 *  clock text committed by its Enter — passed to the confirm so
 *  the save reads the settled value itself, never the state the
 *  choice has only just queued. */
interface StepOverride {
  text?: string;
  key?: string | null;
  people?: Assignee[];
  holderId?: string;
  timeStart?: string;
  timeEnd?: string;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function revisionOf(record: Record<string, unknown>): number | null {
  const value = record["revision"];
  return typeof value === "number" ? value : null;
}

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

type TimeMode = "all_day" | "am" | "pm" | "clock";

function timeModeOf(record: Record<string, unknown>): TimeMode {
  const time = record["time"];
  if (typeof time !== "object" || time === null) return "all_day";
  const t = time as Record<string, unknown>;
  if (t["kind"] === "half_day") return t["half"] === "pm" ? "pm" : "am";
  if (t["kind"] === "clock") return "clock";
  return "all_day";
}

function clockPart(record: Record<string, unknown>, key: "startsAt" | "endsAt"): string {
  const time = record["time"];
  if (typeof time !== "object" || time === null) return "";
  const t = time as Record<string, unknown>;
  return t["kind"] === "clock" && typeof t[key] === "string" ? (t[key] as string) : "";
}

/** The steps this entry's popover walks, in template order, with
 *  the falls-away of the module comment applied. */
export function popoverSteps(target: QuickPopoverTarget, bootstrap: BootstrapData): PopStep[] {
  const steps: PopStep[] = [];
  for (const step of target.template.steps) {
    if (step.kind === "person") {
      steps.push({ kind: "person", label: target.template.personLabel, itemDefinitionId: null });
    } else if (step.kind === "location") {
      // A platform absence has no location field (see the module
      // comment); an event's location step always stands — the
      // list may be empty, and direct input remains (6.4).
      if (target.subjectKind === "event") {
        steps.push({ kind: "location", label: "場所", itemDefinitionId: null });
      }
    } else if (step.kind === "subdivision") {
      const kind = stringField(target.record, "kind") ?? target.template.kindCode;
      const options = bootstrap.absenceSubdivisions.filter((s) => s.code === kind);
      if (target.subjectKind === "absence" && options.length > 0) {
        steps.push({
          kind: "subdivision",
          label: `${target.template.name}分類`,
          itemDefinitionId: null,
        });
      }
    } else if (step.kind === "item") {
      const itemDef = step.itemDefinitionId
        ? bootstrap.itemDefinitions.find((i) => i.id === step.itemDefinitionId)
        : undefined;
      // Only the value shapes this popover can edit stand as a
      // step: a free text, or a choice among the item's options.
      if (itemDef && ["text", "symbol", "code"].includes(itemDef.valueType)) {
        steps.push({ kind: "item", label: itemDef.name, itemDefinitionId: itemDef.id });
      }
    } else if (step.kind === "time") {
      steps.push({
        kind: "time",
        label: target.subjectKind === "absence" ? "時間帯" : "時間",
        itemDefinitionId: null,
      });
    }
  }
  return steps;
}

export function QuickPopover({
  target,
  bootstrap,
  api,
  onSaved,
  onUnauthorizedError,
  onClose,
}: {
  target: QuickPopoverTarget;
  bootstrap: BootstrapData;
  api: ScheduleApi;
  /** A step's save landed: the app re-reads the range. */
  onSaved(): void;
  onUnauthorizedError(): void;
  onClose(): void;
}) {
  const steps = popoverSteps(target, bootstrap);
  const [record, setRecord] = useState(target.record);
  const [stepIndex, setStepIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [placement, setPlacement] = useState({ up: false, right: false });
  const rootRef = useRef<HTMLDivElement>(null);

  const step = steps[stepIndex] as PopStep | undefined;
  const subjectKind = target.subjectKind;
  const recordId = stringField(record, "id") ?? "";

  // ---- step-local drafts (initialised from the record) --------
  const [people, setPeople] = useState<Assignee[]>(() => assigneesOf(target.record));
  const [personText, setPersonText] = useState("");
  const [personHi, setPersonHi] = useState(0);
  const [holderId, setHolderId] = useState<string | null>(() =>
    subjectKind === "absence" ? stringField(target.record, "staffId") : null,
  );
  const [locationText, setLocationText] = useState(() => {
    const id = stringField(target.record, "locationId");
    const found = id ? bootstrap.locations.find((l) => l.id === id) : undefined;
    return found?.name ?? stringField(target.record, "locationText") ?? "";
  });
  const [locationHi, setLocationHi] = useState(0);
  const [subdivision, setSubdivision] = useState<string | null>(() =>
    stringField(target.record, "subdivisionKey"),
  );
  const [itemValues, setItemValues] = useState<EventValueData[] | null>(null);
  const [itemText, setItemText] = useState("");
  const [timeMode, setTimeMode] = useState<TimeMode>(() => timeModeOf(target.record));
  const [timeStart, setTimeStart] = useState(() => clockPart(target.record, "startsAt"));
  const [timeEnd, setTimeEnd] = useState(() => clockPart(target.record, "endsAt"));

  // Placement: beside the cell, flipping at the screen's edges.
  // The popover lives inside the cell, so the table's own scroll
  // carries it along (6.5); only the flip is measured, once.
  useEffect(() => {
    const cell = rootRef.current?.closest("td");
    if (!cell) return;
    const rect = cell.getBoundingClientRect();
    setPlacement({
      up: rect.bottom + 360 > window.innerHeight && rect.top > 360,
      right: rect.left + 320 > window.innerWidth,
    });
  }, []);

  // An outside click closes the popover, like Esc (6.5).
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  // Esc closes the popover wherever the focus sits (6.5): the
  // root's own key handler covers focus inside the popover, and
  // this document-level one covers the rest — a step that holds
  // no focusable control of its own must not strand the keyboard.
  // An Esc that cancels an IME conversion is the conversion's,
  // not the popover's.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The item step reads the record's current values when it opens.
  useEffect(() => {
    if (step?.kind !== "item" || itemValues !== null) return;
    let cancelled = false;
    api
      .getEventValues({ subjectKind, subjectId: recordId })
      .then((rows) => {
        if (cancelled) return;
        setItemValues(rows);
        const itemDef = bootstrap.itemDefinitions.find((i) => i.id === step.itemDefinitionId);
        const row = rows.find((r) => r.itemDefinitionId === step.itemDefinitionId);
        if (row && itemDef) setItemText(itemStepText(row, itemDef));
      })
      .catch((cause: unknown) => {
        if (!cancelled) fail(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [step?.kind, step?.itemDefinitionId]);

  const fail = (cause: unknown) => {
    if (cause instanceof UnauthorizedError) {
      onUnauthorizedError();
      return;
    }
    if (cause instanceof ForbiddenError) {
      setNotice("権限がありません。元の表示に戻しました");
      return;
    }
    setNotice(
      cause instanceof Error && cause.message
        ? `保存できませんでした：${cause.message}`
        : "保存できませんでした",
    );
  };

  /** One relayed save of the whole record with a patch; the
   *  record the platform returns becomes the popover's record. */
  const saveRecord = async (patch: Record<string, unknown>): Promise<boolean> => {
    const revision = revisionOf(record);
    if (revision === null) return false;
    try {
      if (subjectKind === "event") {
        const result = await api.updateEvent({
          id: recordId,
          revision,
          event: { ...record, ...patch },
        });
        setRecord(result.record);
      } else {
        const result = await api.updateAbsence({
          id: recordId,
          revision,
          absence: {
            id: recordId,
            staffId: stringField(record, "staffId") ?? "",
            fromDate: stringField(record, "fromDate") ?? "",
            toDate: stringField(record, "toDate") ?? "",
            time: record["time"] ?? { kind: "all_day" },
            kind: stringField(record, "kind") ?? "",
            certainty: stringField(record, "certainty") ?? "confirmed",
            purpose: record["purpose"] ?? null,
            note: record["note"] ?? null,
            subdivisionKey: stringField(record, "subdivisionKey"),
            ...patch,
          },
        });
        setRecord(result.record);
      }
      onSaved();
      return true;
    } catch (cause) {
      fail(cause);
      return false;
    }
  };

  const stepDirty = (s: PopStep): boolean => {
    switch (s.kind) {
      case "person":
        return subjectKind === "event"
          ? JSON.stringify(people) !== JSON.stringify(assigneesOf(record))
          : holderId !== stringField(record, "staffId");
      case "location": {
        const id = stringField(record, "locationId");
        const initial =
          (id ? bootstrap.locations.find((l) => l.id === id)?.name : undefined) ??
          stringField(record, "locationText") ??
          "";
        return locationText !== initial;
      }
      case "subdivision":
        return subdivision !== stringField(record, "subdivisionKey");
      case "item":
        return itemValues !== null && itemText !== itemStepInitial(s);
      case "time":
        return (
          timeMode !== timeModeOf(record) ||
          (timeMode === "clock" &&
            (timeStart !== clockPart(record, "startsAt") ||
              timeEnd !== clockPart(record, "endsAt")))
        );
    }
  };

  const itemStepInitial = (s: PopStep): string => {
    const itemDef = bootstrap.itemDefinitions.find((i) => i.id === s.itemDefinitionId);
    const row = itemValues?.find((r) => r.itemDefinitionId === s.itemDefinitionId);
    return row && itemDef ? itemStepText(row, itemDef) : "";
  };

  /** Saves the current step if it has unsaved changes; true when
   *  the popover may move on (saved, or nothing to save). */
  const confirmStep = async (s: PopStep, override?: StepOverride): Promise<boolean> => {
    if (busy) return false;
    const overridden =
      override !== undefined &&
      ((s.kind === "location" && override.text !== undefined) ||
        (s.kind === "subdivision" && "key" in override) ||
        (s.kind === "person" &&
          (override.people !== undefined || override.holderId !== undefined)) ||
        (s.kind === "time" &&
          (override.timeStart !== undefined || override.timeEnd !== undefined)));
    if (!overridden && !stepDirty(s)) return true;
    setBusy(true);
    setNotice(null);
    try {
      switch (s.kind) {
        case "person":
          return subjectKind === "event"
            ? await saveRecord({ assignees: override?.people ?? people })
            : await saveRecord({ staffId: override?.holderId ?? holderId });
        case "location": {
          const text = (override?.text ?? locationText).trim();
          const matched = text
            ? bootstrap.locations.find((l) => normalizeName(l.name) === normalizeName(text))
            : undefined;
          return await saveRecord({
            locationId: matched?.id ?? null,
            locationText: matched ? null : text || null,
          });
        }
        case "subdivision":
          return await saveRecord({
            subdivisionKey: override && "key" in override ? override.key : subdivision,
          });
        case "item": {
          if (itemValues === null || !s.itemDefinitionId) return false;
          const itemDef = bootstrap.itemDefinitions.find((i) => i.id === s.itemDefinitionId);
          if (!itemDef) return false;
          const values = itemValues
            .filter((r) => r.itemDefinitionId !== s.itemDefinitionId)
            .map((r) => eventValueInputOf(r, bootstrap))
            .filter((v): v is NonNullable<typeof v> => v !== null);
          const value = itemStepValue(itemText);
          if (value !== null) {
            values.push({ itemDefinitionId: s.itemDefinitionId, target: null, value });
          }
          await api.setEventValues({ subjectKind, subjectId: recordId, values });
          setItemValues(null); // re-read if the step is revisited
          onSaved();
          return true;
        }
        case "time": {
          const start = override?.timeStart ?? timeStart;
          const end = override?.timeEnd ?? timeEnd;
          if (timeMode === "clock") {
            if (!isValidTimeString(start)) {
              setNotice("開始時刻を HH:MM の形で入力してください");
              return false;
            }
            if (end !== "" && !isValidTimeString(end)) {
              setNotice("終了時刻を HH:MM の形で入力してください");
              return false;
            }
            if (end !== "" && timeToMinutes(end) <= timeToMinutes(start)) {
              setNotice("終了は開始より後の時刻にしてください");
              return false;
            }
          }
          const time =
            timeMode === "all_day"
              ? { kind: "all_day" }
              : timeMode === "am" || timeMode === "pm"
                ? { kind: "half_day", half: timeMode }
                : { kind: "clock", startsAt: start, endsAt: end || null };
          return await saveRecord({ time });
        }
      }
    } catch (cause) {
      fail(cause);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const goNext = async (override?: StepOverride) => {
    if (!step) return;
    if (!(await confirmStep(step, override))) return;
    if (stepIndex + 1 < steps.length) setStepIndex(stepIndex + 1);
    else onClose();
  };

  const goTo = async (index: number) => {
    if (index === stepIndex || !step) return;
    if (!(await confirmStep(step))) return;
    setStepIndex(index);
  };

  if (!step) return null;

  const title = subjectKind === "event" ? eventTitle(record) : absenceLineText(record, bootstrap);

  // ---- person step pieces --------------------------------------
  const staff = bootstrap.masters.staff.filter((s) => typeof s.name === "string");
  const personSuggestions = (() => {
    const wanted = normalizeName(personText);
    if (wanted === "") return [];
    return staff
      .filter((s) => normalizeName(s.name as string).includes(wanted))
      .filter(
        (s) =>
          subjectKind !== "event" || !people.some((p) => p.kind === "staff" && p.staffId === s.id),
      )
      .slice(0, 8);
  })();

  /** The assignee a typed (or highlighted) name stands for: a
   *  roster match becomes a staff assignee, any other name stays
   *  free text on an event; an absence's holder must be on the
   *  roster, so an unmatched name yields null and a notice. */
  const assigneeFor = (name: string): Assignee | null => {
    const matched = matchStaffByName(name, bootstrap.masters.staff);
    if (matched) {
      return { kind: "staff", staffId: matched.id, role: target.template.personLabel };
    }
    if (subjectKind === "absence") {
      setNotice(`名簿に一致する教職員がいません：${name}`);
      return null;
    }
    return { kind: "free_text", name, role: target.template.personLabel };
  };

  const addPerson = (name: string) => {
    const assignee = assigneeFor(name);
    if (!assignee) return;
    if (subjectKind === "event") {
      setPeople((current) => [...current, assignee]);
    } else if (assignee.kind === "staff") {
      setHolderId(assignee.staffId);
    }
    setPersonText("");
    setPersonHi(0);
  };

  const onPersonKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (personSuggestions.length === 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      setPersonHi((h) => (h + dir + personSuggestions.length) % personSuggestions.length);
      return;
    }
    if (!isCommitEnter(e)) return;
    e.preventDefault();
    const highlighted = personSuggestions[personHi];
    const name = (highlighted?.name as string | undefined) ?? personText.trim();
    if (e.ctrlKey) {
      // Ctrl+Enter: add the name and stay on this step (6.5).
      if (name) addPerson(name);
      return;
    }
    if (!name) {
      void goNext();
      return;
    }
    const assignee = assigneeFor(name);
    if (!assignee) return;
    // A plain Enter adds the name and confirms the step in one
    // motion; the confirm saves the list with the addition in it
    // (confirmStep's override), not the state queued behind it.
    if (subjectKind === "event") {
      const next = [...people, assignee];
      setPeople(next);
      setPersonText("");
      void goNext({ people: next });
    } else if (assignee.kind === "staff") {
      setHolderId(assignee.staffId);
      setPersonText("");
      void goNext({ holderId: assignee.staffId });
    }
  };

  // ---- location step pieces ------------------------------------
  const locationSuggestions = (() => {
    const wanted = normalizeName(locationText);
    return bootstrap.locations
      .filter((l) => l.isActive)
      .filter((l) => wanted === "" || normalizeName(l.name).includes(wanted))
      .slice(0, 8);
  })();

  const onLocationKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (locationSuggestions.length === 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      setLocationHi((h) => (h + dir + locationSuggestions.length) % locationSuggestions.length);
      return;
    }
    if (!isCommitEnter(e)) return;
    e.preventDefault();
    const highlighted = locationSuggestions[locationHi];
    if (highlighted && normalizeName(highlighted.name) !== normalizeName(locationText)) {
      // Enter on a highlighted suggestion chooses it and confirms
      // with the chosen name itself (see confirmStep's override).
      setLocationText(highlighted.name);
      void goNext({ text: highlighted.name });
      return;
    }
    void goNext();
  };

  const subdivisionOptions = bootstrap.absenceSubdivisions.filter(
    (s) => s.code === (stringField(record, "kind") ?? target.template.kindCode),
  );

  const itemDef =
    step.kind === "item"
      ? bootstrap.itemDefinitions.find((i) => i.id === step.itemDefinitionId)
      : undefined;

  // ---- time step pieces ----------------------------------------
  const timeModes: TimeMode[] =
    subjectKind === "absence" ? ["all_day", "am", "pm", "clock"] : ["all_day", "clock"];

  /** The kind chips are the time step's own control (6.5): the
   *  selected kind's chip holds the focus when the step opens,
   *  the arrow keys move the selection — and the focus with it —
   *  across the kinds, and Enter confirms the step. */
  const onTimeChipsKeyDown = (e: ReactKeyboardEvent) => {
    if (
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowDown"
    ) {
      e.preventDefault();
      const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      const next =
        timeModes[(timeModes.indexOf(timeMode) + dir + timeModes.length) % timeModes.length] ??
        timeMode;
      setTimeMode(next);
      const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
      buttons[timeModes.indexOf(next)]?.focus();
      return;
    }
    if (isCommitEnter(e)) {
      e.preventDefault();
      void goNext();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`quick-popover${placement.up ? " flip-up" : ""}${placement.right ? " flip-right" : ""}`}
      role="dialog"
      aria-label={`${title}のクイック入力`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="quick-popover-head">
        <span className="quick-popover-title">{title}</span>
        <button type="button" aria-label="クイック入力を閉じる" onClick={onClose}>
          ×
        </button>
      </div>
      <ol className="quick-steps">
        {steps.map((s, i) => (
          <li key={`${s.kind}-${s.itemDefinitionId ?? ""}`}>
            <button
              type="button"
              aria-current={i === stepIndex ? "step" : undefined}
              className={i === stepIndex ? "step-head current" : "step-head"}
              onClick={() => void goTo(i)}
            >
              {i + 1}. {s.label}
            </button>
          </li>
        ))}
      </ol>

      <div className="quick-step-body">
        {step.kind === "person" && (
          <div>
            {subjectKind === "event" && people.length > 0 && (
              <ul className="quick-people" aria-label={`選んだ${target.template.personLabel}`}>
                {people.map((p, i) => (
                  <li key={i}>
                    <span>
                      {p.kind === "staff"
                        ? (bootstrap.masters.staff.find((s) => s.id === p.staffId)?.name ??
                          p.staffId)
                        : p.name}
                    </span>
                    <button
                      type="button"
                      aria-label={`${p.kind === "staff" ? p.staffId : p.name}を外す`}
                      onClick={() => setPeople((cur) => cur.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {subjectKind === "absence" && (
              <p className="quick-current">
                現在：
                {holderId ? (staff.find((s) => s.id === holderId)?.name ?? holderId) : "（未定）"}
              </p>
            )}
            <input
              aria-label={target.template.personLabel}
              value={personText}
              autoFocus
              disabled={busy}
              placeholder="名前を入力"
              onChange={(e) => {
                setPersonText(e.target.value);
                setPersonHi(0);
              }}
              onKeyDown={onPersonKeyDown}
            />
            {personSuggestions.length > 0 && (
              <ul className="quick-suggestions" aria-label="候補">
                {personSuggestions.map((s, i) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={i === personHi ? "highlighted" : undefined}
                      onClick={() => addPerson(s.name as string)}
                    >
                      {s.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="quick-hint">
              {subjectKind === "event"
                ? "Ctrl+Enter で追加して続けて入力できます"
                : "名前を選んで Enter で確定します"}
            </p>
          </div>
        )}

        {step.kind === "location" && (
          <div>
            <input
              aria-label="場所"
              value={locationText}
              autoFocus
              disabled={busy}
              placeholder="場所を入力"
              onChange={(e) => {
                setLocationText(e.target.value);
                setLocationHi(0);
              }}
              onKeyDown={onLocationKeyDown}
            />
            {locationSuggestions.length > 0 && (
              <ul className="quick-suggestions" aria-label="場所の候補">
                {locationSuggestions.map((l, i) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      className={i === locationHi ? "highlighted" : undefined}
                      onClick={() => setLocationText(l.name)}
                    >
                      {l.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step.kind === "subdivision" && (
          <ul
            className="quick-options"
            aria-label={step.label}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              const buttons = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
              );
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (index < 0) return;
              e.preventDefault();
              const dir = e.key === "ArrowDown" ? 1 : -1;
              buttons[(index + dir + buttons.length) % buttons.length]?.focus();
            }}
          >
            <li>
              <button
                type="button"
                autoFocus={subdivision === null}
                aria-pressed={subdivision === null}
                className={subdivision === null ? "selected" : undefined}
                onClick={() => {
                  setSubdivision(null);
                  void goNext({ key: null });
                }}
              >
                （なし）
              </button>
            </li>
            {subdivisionOptions.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  autoFocus={subdivision === option.key}
                  aria-pressed={subdivision === option.key}
                  className={subdivision === option.key ? "selected" : undefined}
                  onClick={() => {
                    setSubdivision(option.key);
                    void goNext({ key: option.key });
                  }}
                >
                  {option.label}
                </button>
              </li>
            ))}
          </ul>
        )}

        {step.kind === "item" && itemDef && (
          <div>
            {itemDef.valueType === "text" ? (
              <input
                aria-label={itemDef.name}
                value={itemText}
                autoFocus
                disabled={busy || itemValues === null}
                onChange={(e) => setItemText(e.target.value)}
                onKeyDown={(e) => {
                  if (isCommitEnter(e)) {
                    e.preventDefault();
                    void goNext();
                  }
                }}
              />
            ) : (
              <select
                aria-label={itemDef.name}
                value={itemText}
                autoFocus
                disabled={busy || itemValues === null}
                onChange={(e) => setItemText(e.target.value)}
              >
                <option value="">（なし）</option>
                {itemDef.options.map((o) => (
                  <option key={o.id} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            {itemValues === null && <p className="quick-hint">読み込み中…</p>}
          </div>
        )}

        {step.kind === "time" && (
          <div>
            <div
              className="kind-chips"
              role="group"
              aria-label={step.label}
              onKeyDown={onTimeChipsKeyDown}
            >
              {timeModes.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  autoFocus={timeMode === mode}
                  aria-pressed={timeMode === mode}
                  className={timeMode === mode ? "chip selected" : "chip"}
                  onClick={() => setTimeMode(mode)}
                >
                  {mode === "all_day"
                    ? "終日"
                    : mode === "am"
                      ? "午前"
                      : mode === "pm"
                        ? "午後"
                        : "時刻指定"}
                </button>
              ))}
            </div>
            {timeMode === "clock" && (
              <>
                {/* No autoFocus on the pickers: the step's focus
                    stays on the kind chips above, so the arrow
                    keys keep moving across the kinds even after
                    時刻指定 opens the pickers. */}
                <ClockPicker
                  label="開始"
                  value={timeStart}
                  onChange={setTimeStart}
                  onEnter={(value) => void goNext({ timeStart: value })}
                />
                <ClockPicker
                  label="終了"
                  value={timeEnd}
                  onChange={setTimeEnd}
                  onEnter={(value) => void goNext({ timeEnd: value })}
                />
              </>
            )}
          </div>
        )}
      </div>

      {notice && (
        <p className="cell-notice" role="alert">
          {notice}
        </p>
      )}
      <div className="quick-popover-foot">
        <button type="button" disabled title="詳細モーダルは次の Issue で対応します">
          詳細を開く
        </button>
        <span className="quick-foot-actions">
          {stepIndex + 1 < steps.length && (
            <button type="button" onClick={() => setStepIndex(stepIndex + 1)}>
              スキップ
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void goNext()}>
            {stepIndex + 1 < steps.length ? "次へ" : "確定"}
          </button>
        </span>
      </div>
    </div>
  );
}

/** The text an item step's control starts from: the stored value
 *  read back in the item definition's own terms. */
function itemStepText(row: EventValueData, itemDef: ItemDefinitionData): string {
  if (itemDef.valueType === "symbol" || itemDef.valueType === "code") {
    return itemDef.options.find((o) => o.id === row.valueOptionId)?.code ?? "";
  }
  return row.valueText ?? "";
}

/** The raw value an item step sends for its text — for a choice
 *  item the control already holds the option's code: empty clears
 *  the item (the caller leaves it out of the rewritten set). */
function itemStepValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return trimmed;
}

/** One stored value read back as a setEventValues input, so a
 *  rewrite of the whole set keeps the items this popover did not
 *  touch. A row whose value cannot be read back in its item's
 *  terms — an option id the definition no longer has, a target
 *  known only by id — is left out rather than guessed. */
function eventValueInputOf(
  row: EventValueData,
  bootstrap: BootstrapData,
): {
  itemDefinitionId: string;
  target: TargetRefData | null;
  value: unknown;
} | null {
  const itemDef = bootstrap.itemDefinitions.find((i) => i.id === row.itemDefinitionId);
  if (!itemDef) return null;
  if (row.targetId && !row.targetRef) return null;
  let value: unknown;
  if (row.valueOptionId) {
    const code = itemDef.options.find((o) => o.id === row.valueOptionId)?.code;
    if (code === undefined) return null;
    value = code;
  } else if (row.valueTime) {
    value = row.valueTimeEnd
      ? { startsAt: row.valueTime, endsAt: row.valueTimeEnd }
      : row.valueTime;
  } else if (row.valueText !== null) {
    value = row.valueText;
  } else if (row.valueNumber !== null) {
    value = row.valueNumber;
  } else if (row.valueBoolean !== null) {
    value = row.valueBoolean;
  } else if (row.valuePersonId !== null) {
    value = row.valuePersonId;
  } else {
    return null;
  }
  return { itemDefinitionId: row.itemDefinitionId, target: row.targetRef, value };
}
