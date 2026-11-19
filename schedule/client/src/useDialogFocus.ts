import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { isImeKeyEvent } from "./cells";

/**
 * The one focus discipline every dialog on these screens shares
 * (Issue #89): the detail modal trapped nothing and the panels
 * trapped nothing either, each in its own way — Tab walked out
 * into the table behind, Esc closed some dialogs and not others,
 * and closing left the focus wherever the unmounted dialog had
 * held it. This hook is the shared shape, used by DetailModal,
 * QuickPopover, DutyPanel, PendingPanel, PublishPanel and
 * SettingsPanel alike:
 *
 * - On open, focus lands on the first input field in the dialog
 *   (a form the caller already auto-focuses is left alone); with
 *   no input field, the dialog itself takes the focus — every
 *   dialog root carries tabIndex={-1} for that.
 * - Tab and Shift+Tab cycle inside the dialog. The movement is
 *   driven from the keydown itself rather than left to the
 *   browser's order, because two of the dialogs live inside a
 *   table cell: the DOM after them is the rest of the table, and
 *   the browser's next stop out of the dialog's last control is
 *   a cell behind it.
 * - Esc closes, through isImeKeyEvent, so an Esc that cancels an
 *   IME conversion belongs to the conversion, not the dialog.
 *   The listener sits on the document, so Esc also closes when
 *   the focus has slipped out of the dialog (a mousedown on an
 *   empty part of a cell-hosted dialog moves the focus to the
 *   cell behind it) — the behaviour PR #77/#80 settled.
 * - On close, focus returns to the element that held it before
 *   the dialog opened. That element is read during the first
 *   render, not in an effect: by effect time a form's autoFocus
 *   may already have moved the focus into the dialog. When the
 *   remembered element is gone by close time — the detail modal
 *   opened from the popover remembers a popover control, the
 *   cell's re-edit input closes behind its modal — the host
 *   cell takes the focus instead, so a keyboard user lands back
 *   on the cell they were editing.
 *
 * Dialogs stack: only the topmost open dialog answers Tab and
 * Esc, so a dialog opened over another never has its keys taken
 * by the one behind.
 */

const INPUT_LIKE =
  "input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled])";
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  INPUT_LIKE,
  "iframe",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/** Open dialogs, in the order they opened; the last is topmost. */
const dialogStack: object[] = [];

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("hidden"),
  );
}

export function useDialogFocus<T extends HTMLElement>(onClose: () => void): RefObject<T | null> {
  const rootRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // The focus to restore on close, read once at the first render
  // (see the header): the element itself, plus its host cell as
  // the fallback for when the element is unmounted by close time.
  const restoreRef = useRef<{ target: HTMLElement | null; cell: HTMLElement | null } | null>(null);
  if (restoreRef.current === null) {
    const active = document.activeElement;
    const el = active instanceof HTMLElement && active !== document.body ? active : null;
    restoreRef.current = {
      target: el,
      cell: el ? (el.closest("td") as HTMLElement | null) : null,
    };
  }

  // A layout effect, not a passive one (Issue #100): the dialog
  // must be armed — on the stack, focus inside, key listener on
  // the document — in the same commit that puts it in the DOM. A
  // passive effect leaves a gap between the node appearing and
  // the listener landing, and an Esc that arrives inside the gap
  // (a fast keyboard, an automated one) is lost for good: the
  // dialog stays open with nothing left to close it. This app is
  // client-only, so the layout effect's server-rendering caveat
  // does not apply.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const token = {};
    dialogStack.push(token);

    const active = document.activeElement;
    if (!(active instanceof Node) || !root.contains(active)) {
      const firstInput = root.querySelector<HTMLElement>(INPUT_LIKE);
      if (firstInput) firstInput.focus();
      else root.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== token) return;
      if (e.key === "Escape") {
        // isImeKeyEvent reads the React event shape; a native
        // event carries the same three facts on itself.
        const asReact = {
          key: e.key,
          keyCode: e.keyCode,
          nativeEvent: e,
        } as unknown as ReactKeyboardEvent;
        if (isImeKeyEvent(asReact)) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableIn(root);
      e.preventDefault();
      if (items.length === 0) {
        root.focus();
        return;
      }
      const current = document.activeElement;
      const index = current instanceof HTMLElement ? items.indexOf(current) : -1;
      const next =
        index === -1
          ? e.shiftKey
            ? items[items.length - 1]
            : items[0]
          : items[(index + (e.shiftKey ? -1 : 1) + items.length) % items.length];
      next?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const at = dialogStack.indexOf(token);
      if (at >= 0) dialogStack.splice(at, 1);
      const restore = restoreRef.current;
      if (restore?.target?.isConnected) restore.target.focus();
      else if (restore?.cell?.isConnected) restore.cell.focus();
    };
  }, []);

  return rootRef;
}
