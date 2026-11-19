import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { ScheduleApi } from "../src/api";
import { createDevApi } from "../src/devAdapter";

afterEach(cleanup);

// The dialogs' shared focus discipline (Issue #89): every
// dialog on these screens — the detail modal, the quick-entry
// popover and the four panels — opens with the focus inside,
// keeps Tab and Shift+Tab cycling inside, closes on Esc (but
// never on the Esc that cancels an IME conversion), and hands
// the focus back to whatever held it before the dialog opened.
// One discipline, in useDialogFocus; these tests walk each
// dialog through the same four checks against the dev adapter.

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), " +
  "select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex='-1'])";

function focusablesOf(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("hidden"),
  );
}

/** Tab wraps from the last control to the first, Shift+Tab
 *  from the first back to the last, and a plain Tab in between
 *  steps forward — the focus never leaves the dialog. */
function expectTabCyclesInside(dialog: HTMLElement) {
  const items = focusablesOf(dialog);
  expect(items.length).toBeGreaterThan(1);
  const first = items[0] as HTMLElement;
  const last = items[items.length - 1] as HTMLElement;
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  first.focus();
  fireEvent.keyDown(first, { key: "Tab" });
  expect(document.activeElement).toBe(items[1]);
  expect(dialog.contains(document.activeElement)).toBe(true);
}

/** An IME conversion's Esc leaves the dialog standing; a
 *  plain Esc closes it. */
async function expectEscCloses(dialog: HTMLElement) {
  const inside = focusablesOf(dialog)[0] as HTMLElement;
  inside.focus();
  fireEvent.keyDown(inside, { key: "Escape", isComposing: true });
  expect(screen.queryByRole("dialog")).toBeInTheDocument();
  fireEvent.keyDown(inside, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

/** One cell of the staff month table, by date and column order
 *  (0 行事 / 1 給食 / 2 下校時刻 / 3 バス / 4 清掃 / 5 日番 /
 *  6 〆切 / 7 職員動静) — the same map modal.test.tsx uses. */
function cellFor(date: string, columnIndex: number): HTMLElement {
  const row = document.querySelector(`tr[data-date="${date}"]`);
  if (!row) throw new Error(`no row for ${date}`);
  const cell = row.querySelectorAll("td")[columnIndex];
  if (!cell) throw new Error(`no cell ${columnIndex} for ${date}`);
  return cell as HTMLElement;
}

function entryButton(cell: HTMLElement, text: string): HTMLElement {
  const found = [...cell.querySelectorAll<HTMLElement>("button.entry-open")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!found) throw new Error(`no entry button for ${text}`);
  return found;
}

async function renderApp(api: ScheduleApi) {
  render(<App api={api} initialAnchor="2026-11-15" />);
  await screen.findByText("開発用小学校");
  await waitFor(() => expect(document.querySelector('tr[data-date="2026-11-16"]')).not.toBeNull());
}

describe("dialog focus discipline (Issue #89)", () => {
  it("detail modal: focus enters, Tab cycles, Esc closes, focus returns to the entry", async () => {
    const api = createDevApi();
    await renderApp(api);
    const opener = entryButton(cellFor("2026-11-06", 0), "授業参観");
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "行事の詳細" });
    // The name comes from the heading itself.
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)?.textContent).toBe("行事の詳細");
    // On open, the focus is inside the modal.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expectTabCyclesInside(dialog);
    await expectEscCloses(dialog);
    // Closing hands the focus back to the entry that opened it.
    expect(document.activeElement).toBe(opener);
  }, 20000);

  it("quick popover: focus enters, Tab cycles, Esc closes, focus returns to the cell's input", async () => {
    const api = createDevApi();
    await renderApp(api);
    const eventsCell = cellFor("2026-11-16", 0);
    fireEvent.click(eventsCell);
    const input = within(eventsCell).getByLabelText(/行事の入力/);
    fireEvent.change(input, { target: { value: "運動会" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", { name: "運動会のクイック入力" });
    // The popover is treated as a modal dialog while it is open.
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expectTabCyclesInside(dialog);
    await expectEscCloses(dialog);
    // The focus returns to the cell's input, which held it
    // before the popover opened and stayed mounted behind it.
    expect(document.activeElement).toBe(input);
  }, 20000);

  it("quick popover: an Esc that arrives the moment it appears still closes it", async () => {
    const api = createDevApi();
    await renderApp(api);
    // The Esc is dispatched in the very microtask in which the
    // popover's node first appears (a MutationObserver callback) —
    // before any passive effect could have run. The popover's key
    // handling must therefore be armed during the commit itself,
    // or this Esc is lost and the popover stays open (Issue #100).
    let fired = false;
    const observer = new MutationObserver(() => {
      if (fired || !document.querySelector('[role="dialog"]')) return;
      fired = true;
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      const eventsCell = cellFor("2026-11-16", 0);
      fireEvent.click(eventsCell);
      const input = within(eventsCell).getByLabelText(/行事の入力/);
      fireEvent.change(input, { target: { value: "運動会" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(fired).toBe(true));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    } finally {
      observer.disconnect();
    }
  }, 20000);

  it("duty panel: focus enters, Tab cycles, Esc closes, focus returns to the toolbar button", async () => {
    const api = createDevApi();
    await renderApp(api);
    const opener = screen.getByRole("button", { name: /当番・競合/ });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "当番・競合・交代" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expectTabCyclesInside(dialog);
    await expectEscCloses(dialog);
    expect(document.activeElement).toBe(opener);
  }, 20000);

  it("pending panel: the dialog itself takes the focus, Tab cycles, Esc closes, focus returns", async () => {
    const api = createDevApi();
    await renderApp(api);
    const opener = screen.getByRole("button", { name: "確認待ち" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "確認待ちの一覧" });
    await within(dialog).findByText(/市教研研修会/);
    // The queue carries no input field, so the dialog itself
    // holds the focus on open.
    expect(document.activeElement).toBe(dialog);
    expectTabCyclesInside(dialog);
    await expectEscCloses(dialog);
    expect(document.activeElement).toBe(opener);
  }, 20000);

  it("publish panel: focus enters, Tab cycles, Esc closes, focus returns to the toolbar button", async () => {
    const api = createDevApi();
    await renderApp(api);
    const opener = screen.getByRole("button", { name: "発行・印刷" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: /発行・印刷（/ });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expectTabCyclesInside(dialog);
    await expectEscCloses(dialog);
    expect(document.activeElement).toBe(opener);
  }, 20000);

  it("settings panel: focus enters, Tab cycles, Esc closes, focus returns to the toolbar button", async () => {
    const api = createDevApi();
    await renderApp(api);
    const opener = screen.getByRole("button", { name: "設定" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
    // The sections land with the panel's loads; wait for one.
    await within(dialog).findByText("プリセットと学校設定");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expectTabCyclesInside(dialog);
    await expectEscCloses(dialog);
    expect(document.activeElement).toBe(opener);
  }, 20000);
});
