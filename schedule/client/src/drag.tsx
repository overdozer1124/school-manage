import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ApiError, ForbiddenError, UnauthorizedError } from "./api";
import type { CellEditorContext } from "./cells";
import { movedEventRecord } from "./lib";

/**
 * Drag & drop moving of event objects (Issue #50; DESIGN
 * schedule 6.2-4.1), ported from the prototype's pointer drag
 * (school-schedule client/src/App.tsx). One pointer path serves
 * mouse, pen and touch: a press on a changeable event records a
 * drag candidate, and the drag itself begins only after the
 * pointer moves past a small threshold — so a plain click keeps
 * its meaning (the detail modal opens) — while a ghost chip
 * follows the pointer and the day cell under it highlights
 * through its `data-drop-date`. The click that trails a real
 * drag is suppressed once, so dropping an entry never also
 * opens what it was dropped on.
 *
 * The move itself is an ordinary event update through the
 * relay (Issue #29): only the dates change (lib's
 * movedEventRecord), offered against the record's current
 * revision. A stale revision comes back as the platform's 409;
 * any failure re-reads the range — the display returns to what
 * the server holds — and leaves a notice by the table (the
 * app renders it). A landed move marks the entry briefly
 * (justMovedId), the visual feedback the design asks for.
 *
 * Only event records are draggable: absences and daily values
 * stay with their own editors, and an entry with no platform
 * revision (a provisional shape the relay has not settled) has
 * nothing to offer the update against.
 */
export interface EventDragContext {
  /** The id of the event being dragged, or null. */
  draggingId: string | null;
  /** The date of the day cell under the pointer, or null. */
  dropDate: string | null;
  /** The id of the event that just landed, briefly marked. */
  justMovedId: string | null;
  /** The ghost chip following the pointer, or null. */
  ghost: { label: string; x: number; y: number } | null;
  /** The notice the last failed move left, or null. */
  notice: string | null;
  /** pointerdown on a draggable event element. */
  startDrag(
    record: Record<string, unknown>,
    grabDate: string,
    label: string,
    e: ReactPointerEvent,
  ): void;
  /** True while the click trailing a finished drag must be
   *  ignored (the prototype's 400 ms window). */
  shouldSuppressClick(): boolean;
  /** The props that mark one day cell as a drop target. */
  dropTargetProps(date: string): { "data-drop-date": string };
}

interface DragCandidate {
  record: Record<string, unknown>;
  grabDate: string;
  label: string;
  startX: number;
  startY: number;
  active: boolean;
}

/** How far the pointer must travel before a press becomes a
 *  drag (the prototype's threshold). */
const DRAG_THRESHOLD_PX = 8;
const CLICK_SUPPRESS_MS = 400;
/** How long the landed entry stays marked. */
const MOVED_MARK_MS = 2000;

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function revisionOf(record: Record<string, unknown>): number | null {
  const value = record["revision"];
  return typeof value === "number" ? value : null;
}

export function useEventDrag(editor: CellEditorContext): EventDragContext {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropDate, setDropDate] = useState<string | null>(null);
  const [justMovedId, setJustMovedId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ label: string; x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const candidateRef = useRef<DragCandidate | null>(null);
  const dropDateRef = useRef<string | null>(null);
  const suppressUntilRef = useRef(0);
  const movedTimerRef = useRef<number | null>(null);
  // The window listeners live for the app's life and run
  // through refs, so a pointermove never re-registers them.
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const moveEvent = useCallback(
    async (record: Record<string, unknown>, grabDate: string, targetDate: string) => {
      const ed = editorRef.current;
      const id = stringField(record, "id");
      const revision = revisionOf(record);
      const next = movedEventRecord(record, grabDate, targetDate);
      if (!next || !id || revision === null) return;
      try {
        await ed.api.updateEvent({ id, revision, event: next });
        ed.onSaved();
        setNotice(null);
        setJustMovedId(id);
        if (movedTimerRef.current !== null) window.clearTimeout(movedTimerRef.current);
        movedTimerRef.current = window.setTimeout(() => setJustMovedId(null), MOVED_MARK_MS);
      } catch (cause) {
        if (cause instanceof UnauthorizedError) {
          ed.onUnauthorizedError();
          return;
        }
        // The display goes back to what the server holds: the
        // range is re-read, and the failure is told.
        ed.onSaved();
        if (cause instanceof ApiError && cause.status === 409) {
          setNotice(
            "他の人がこの予定を変更したため、移動できませんでした。最新の内容に戻しました。",
          );
        } else if (cause instanceof ForbiddenError) {
          setNotice("権限がありません。元の表示に戻しました");
        } else {
          setNotice(
            `移動できませんでした：${cause instanceof Error && cause.message ? cause.message : "保存できませんでした"}`,
          );
        }
      }
    },
    [],
  );
  const moveEventRef = useRef(moveEvent);
  moveEventRef.current = moveEvent;

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const cur = candidateRef.current;
      if (!cur) return;
      const active =
        cur.active ||
        Math.hypot(e.clientX - cur.startX, e.clientY - cur.startY) > DRAG_THRESHOLD_PX;
      candidateRef.current = { ...cur, active };
      if (!active) return;
      setDraggingId(stringField(cur.record, "id"));
      setGhost({ label: cur.label, x: e.clientX, y: e.clientY });
      const el = document
        .elementFromPoint?.(e.clientX, e.clientY)
        ?.closest?.("[data-drop-date]") as HTMLElement | null;
      const date = el?.dataset.dropDate ?? null;
      dropDateRef.current = date;
      setDropDate((prev) => (prev === date ? prev : date));
    };
    const finish = (commit: boolean) => {
      const cur = candidateRef.current;
      if (!cur) return;
      const target = dropDateRef.current;
      candidateRef.current = null;
      dropDateRef.current = null;
      setGhost(null);
      setDropDate(null);
      setDraggingId(null);
      if (!commit || !cur.active) return;
      suppressUntilRef.current = Date.now() + CLICK_SUPPRESS_MS;
      if (target) void moveEventRef.current(cur.record, cur.grabDate, target);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, []);

  const startDrag = useCallback(
    (record: Record<string, unknown>, grabDate: string, label: string, e: ReactPointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      candidateRef.current = {
        record,
        grabDate,
        label,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
      };
    },
    [],
  );

  const shouldSuppressClick = useCallback(() => Date.now() < suppressUntilRef.current, []);

  const dropTargetProps = useCallback((date: string) => ({ "data-drop-date": date }), []);

  return {
    draggingId,
    dropDate,
    justMovedId,
    ghost,
    notice,
    startDrag,
    shouldSuppressClick,
    dropTargetProps,
  };
}
