import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { ApiError, type ScheduleApi } from "../src/api";
import { CalendarGrid } from "../src/CalendarGrid";
import type { CellEditorContext } from "../src/cells";
import { createDevApi } from "../src/devAdapter";
import { useEventDrag } from "../src/drag";
import { dayDiff, movedEventRecord, rangeFor } from "../src/lib";
import type { BootstrapData, RangeData } from "../src/types";

afterEach(cleanup);

// Drag & drop moving tests (Issue #50; DESIGN schedule
// 6.2-4.1): an event grabbed in one day's cell and dropped on
// another day moves through the updateEvent relay with only
// its dates changed; a multi-day event moves as a whole span;
// a conflict (the platform's 409) puts the display back to the
// latest content with a notice; absences are not grabbed. The
// API is the development adapter with an updateEvent spy (and,
// for the conflict, a 409 armed) over it. jsdom has no layout,
// so the drag's hit-testing (document.elementFromPoint) is
// stood in by the intended target element for each gesture.

type UpdateCall = {
  id: string;
  revision: number;
  event: Record<string, unknown>;
};

function eventRecord(partial: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "ev-drag",
    kind: "event",
    kindLabel: null,
    title: "ドラッグ会議",
    datePrecision: "day",
    startsOn: "2026-11-16",
    endsOn: "2026-11-16",
    time: { kind: "clock", startsAt: "13:00", endsAt: "14:00" },
    locationId: null,
    locationText: null,
    description: null,
    certainty: "confirmed",
    visibility: "staff_only",
    targets: [],
    impacts: [],
    assignees: [{ kind: "staff", staffId: "teacher-1", role: "担当者" }],
    ...partial,
  };
}

function spiedApi(base: ScheduleApi, calls: UpdateCall[]): ScheduleApi {
  return {
    ...base,
    updateEvent: async (input) => {
      calls.push(input);
      return base.updateEvent(input);
    },
  };
}

function rowOf(date: string): HTMLElement {
  const row = document.querySelector(`tbody tr[data-date="${date}"]`);
  if (!row) throw new Error(`no row for ${date}`);
  return row as HTMLElement;
}

function dropCellOf(date: string): HTMLElement {
  const cell = rowOf(date).querySelector("td[data-drop-date]");
  if (!cell) throw new Error(`no drop cell for ${date}`);
  return cell as HTMLElement;
}

/** The entry-open button of one entry line, by its text. */
function entryButton(scope: HTMLElement, text: string): HTMLElement {
  const found = [...scope.querySelectorAll("button.entry-open")].find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!found) throw new Error(`no entry button for ${text}`);
  return found as HTMLElement;
}

/** One full drag gesture: press on the entry, travel (past the
 *  threshold, with the hit-test pointed at the target), let go. */
function dragEntry(from: HTMLElement, target: Element) {
  document.elementFromPoint = () => target;
  fireEvent.pointerDown(from, { clientX: 10, clientY: 10, button: 0, pointerType: "mouse" });
  fireEvent.pointerMove(window, { clientX: 90, clientY: 60 });
  fireEvent.pointerUp(window);
}

describe("lib: the moved record", () => {
  it("shifts only the dates, the whole span together", () => {
    const event = {
      id: "e1",
      title: "合宿",
      startsOn: "2026-11-17",
      endsOn: "2026-11-19",
      time: { kind: "clock", startsAt: "09:00", endsAt: "10:00" },
      assignees: [{ kind: "staff", staffId: "s1", role: "担当者" }],
      revision: 3,
    };
    // Grabbed by its middle day, dropped two days later: the
    // grabbed day lands on the drop day, the span follows.
    const moved = movedEventRecord(event, "2026-11-18", "2026-11-20");
    expect(moved).toEqual({ ...event, startsOn: "2026-11-19", endsOn: "2026-11-21" });
    expect(moved).not.toBe(event);
    expect(event.startsOn).toBe("2026-11-17");
  });

  it("moves backwards, and counts whole days across a month edge", () => {
    expect(
      movedEventRecord(
        { startsOn: "2026-11-16", endsOn: "2026-11-16" },
        "2026-11-16",
        "2026-11-13",
      )?.["startsOn"],
    ).toBe("2026-11-13");
    expect(dayDiff("2026-11-16", "2026-11-18")).toBe(2);
    expect(dayDiff("2026-11-18", "2026-11-16")).toBe(-2);
    expect(dayDiff("2026-11-30", "2026-12-02")).toBe(2);
  });

  it("is null for a same-day drop or a record with no usable span", () => {
    expect(
      movedEventRecord(
        { startsOn: "2026-11-16", endsOn: "2026-11-16" },
        "2026-11-16",
        "2026-11-16",
      ),
    ).toBeNull();
    expect(movedEventRecord({ title: "x" }, "2026-11-16", "2026-11-17")).toBeNull();
    expect(
      movedEventRecord(
        { startsOn: "2026-11-19", endsOn: "2026-11-17" },
        "2026-11-17",
        "2026-11-18",
      ),
    ).toBeNull();
  });
});

describe("drag & drop moving in the rows tables (L1 / L2)", () => {
  it("moves an event to another day, changing only its dates", async () => {
    const base = createDevApi();
    await base.createEvent({ event: eventRecord() });
    const calls: UpdateCall[] = [];
    render(<App api={spiedApi(base, calls)} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    const button = await waitFor(() => entryButton(rowOf("2026-11-16"), "ドラッグ会議"));
    dragEntry(button, dropCellOf("2026-11-18"));
    await waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0] as UpdateCall;
    expect(call.id).toBe("ev-drag");
    expect(call.revision).toBe(1);
    // Only the dates changed: time, assignees and title ride
    // along untouched.
    expect(call.event["startsOn"]).toBe("2026-11-18");
    expect(call.event["endsOn"]).toBe("2026-11-18");
    expect(call.event["title"]).toBe("ドラッグ会議");
    expect(call.event["time"]).toEqual({ kind: "clock", startsAt: "13:00", endsAt: "14:00" });
    expect(call.event["assignees"]).toEqual([
      { kind: "staff", staffId: "teacher-1", role: "担当者" },
    ]);
    // The table re-reads: the entry stands on the new day only.
    await waitFor(() => {
      expect(within(rowOf("2026-11-18")).queryByText(/ドラッグ会議/)).not.toBeNull();
    });
    expect(within(rowOf("2026-11-16")).queryByText(/ドラッグ会議/)).toBeNull();
  });

  it("moves a multi-day event as a whole span, from the grabbed day", async () => {
    const base = createDevApi();
    await base.createEvent({
      event: eventRecord({
        id: "ev-drag-span",
        title: "ドラッグ研修",
        datePrecision: "range",
        startsOn: "2026-11-17",
        endsOn: "2026-11-19",
        time: null,
        assignees: [],
      }),
    });
    const calls: UpdateCall[] = [];
    render(<App api={spiedApi(base, calls)} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    // The span stands in every day it covers; grab the middle
    // day's line and drop it on the 20th.
    const button = await waitFor(() => entryButton(rowOf("2026-11-18"), "ドラッグ研修"));
    dragEntry(button, dropCellOf("2026-11-20"));
    await waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0] as UpdateCall;
    expect(call.event["startsOn"]).toBe("2026-11-19");
    expect(call.event["endsOn"]).toBe("2026-11-21");
  });

  it("works the same in the L2 week table", async () => {
    const base = createDevApi();
    await base.createEvent({ event: eventRecord() });
    const calls: UpdateCall[] = [];
    render(<App api={spiedApi(base, calls)} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "view-week-staff" } });
    // The week's own table must be the one standing before the
    // grab — the month table's button leaves the DOM with it.
    await screen.findByText("2026-11-09 〜 2026-11-22");
    const button = await waitFor(() => entryButton(rowOf("2026-11-16"), "ドラッグ会議"));
    dragEntry(button, dropCellOf("2026-11-13"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.event["startsOn"]).toBe("2026-11-13");
    expect(calls[0]?.event["endsOn"]).toBe("2026-11-13");
  });

  it("highlights the day under the drag, follows with a ghost, and swallows the trailing click", async () => {
    const base = createDevApi();
    await base.createEvent({ event: eventRecord() });
    const calls: UpdateCall[] = [];
    render(<App api={spiedApi(base, calls)} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    const button = await waitFor(() => entryButton(rowOf("2026-11-16"), "ドラッグ会議"));
    const target = dropCellOf("2026-11-18");
    document.elementFromPoint = () => target;
    fireEvent.pointerDown(button, { clientX: 10, clientY: 10, button: 0, pointerType: "mouse" });
    fireEvent.pointerMove(window, { clientX: 90, clientY: 60 });
    // Mid-drag: the target day highlights and the ghost stands.
    expect(target.className).toContain("drop-target");
    expect(document.querySelector(".drag-ghost")?.textContent).toContain("ドラッグ会議");
    fireEvent.pointerUp(window);
    // The click trailing the drop is the drop, not an opening:
    // fired at once, while the suppression window stands, it
    // does not open the detail modal.
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => {
      expect(within(rowOf("2026-11-18")).queryByText(/ドラッグ会議/)).not.toBeNull();
    });
  });

  it("a conflict (409) puts the display back to the latest content, with a notice", async () => {
    const base = createDevApi();
    await base.createEvent({ event: eventRecord() });
    let fail = false;
    const api: ScheduleApi = {
      ...base,
      updateEvent: async (input) => {
        if (fail) throw new ApiError(409, "revision conflict");
        return base.updateEvent(input);
      },
    };
    render(<App api={api} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    const button = await waitFor(() => entryButton(rowOf("2026-11-16"), "ドラッグ会議"));
    // Another person saves first: the stored record moves on
    // (a new title, a new revision) while this screen still
    // shows the copy it read.
    await base.updateEvent({
      id: "ev-drag",
      revision: 1,
      event: eventRecord({ title: "ドラッグ会議（変更後）" }),
    });
    fail = true;
    dragEntry(button, dropCellOf("2026-11-18"));
    // The failure is told, and the re-read table shows the
    // other person's version — on the original day, unmoved.
    expect(await screen.findByText(/最新の内容に戻しました/)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(rowOf("2026-11-16")).queryByText(/変更後/)).not.toBeNull();
    });
    expect(within(rowOf("2026-11-18")).queryByText(/ドラッグ会議/)).toBeNull();
  });

  it("the failed move's notice can be closed, and a change of view or period clears it (Issue #125)", async () => {
    const base = createDevApi();
    await base.createEvent({ event: eventRecord() });
    const api: ScheduleApi = {
      ...base,
      updateEvent: async () => {
        throw new ApiError(409, "revision conflict");
      },
    };
    render(<App api={api} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    const noticeGone = () =>
      waitFor(() => expect(screen.queryByText(/最新の内容に戻しました/)).toBeNull());

    // First failure: the notice stands, and its close button
    // dismisses it where it stands.
    const button = await waitFor(() => entryButton(rowOf("2026-11-16"), "ドラッグ会議"));
    dragEntry(button, dropCellOf("2026-11-18"));
    expect(await screen.findByText(/最新の内容に戻しました/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "お知らせを閉じる" }));
    await noticeGone();

    // Second failure: switching the view clears the notice.
    const buttonAgain = await waitFor(() => entryButton(rowOf("2026-11-16"), "ドラッグ会議"));
    dragEntry(buttonAgain, dropCellOf("2026-11-18"));
    expect(await screen.findByText(/最新の内容に戻しました/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "view-week-staff" } });
    await screen.findByText("2026-11-09 〜 2026-11-22");
    await noticeGone();

    // Third failure, in the week table: moving to the next
    // period clears the notice too.
    const weekButton = await waitFor(() => entryButton(rowOf("2026-11-16"), "ドラッグ会議"));
    dragEntry(weekButton, dropCellOf("2026-11-13"));
    expect(await screen.findByText(/最新の内容に戻しました/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    await noticeGone();
  });

  it("does not grab an absence line", async () => {
    const base = createDevApi();
    const calls: UpdateCall[] = [];
    render(<App api={spiedApi(base, calls)} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    // The dev fixtures hold a leave on 2026-11-16.
    const absence = await waitFor(() => entryButton(rowOf("2026-11-16"), "年休"));
    dragEntry(absence, dropCellOf("2026-11-18"));
    expect(calls).toHaveLength(0);
    expect(document.querySelector(".drag-ghost")).toBeNull();
  });
});

/** The calendar grid with a drag context of its own: the
 *  harness stands in for the app shell, which wires the same
 *  pair together. */
function GridHarness({
  api,
  bootstrap,
  range,
}: {
  api: ScheduleApi;
  bootstrap: BootstrapData;
  range: RangeData;
}) {
  const editor: CellEditorContext = {
    api,
    onSaved: () => {},
    onUnauthorizedError: () => {},
  };
  const drag = useEventDrag(editor);
  return (
    <>
      <CalendarGrid
        bootstrap={bootstrap}
        range={range}
        anchor="2026-11-15"
        editor={editor}
        drag={drag}
      />
      {drag.ghost && <div className="drag-ghost">{drag.ghost.label}</div>}
    </>
  );
}

describe("drag & drop moving in the calendar grid (L4)", () => {
  it("moves an event line to another day cell", async () => {
    const base = createDevApi();
    await base.createEvent({
      event: eventRecord({
        id: "ev-drag-grid",
        title: "ドラッグ集会",
        startsOn: "2026-11-20",
        endsOn: "2026-11-20",
        time: null,
        assignees: [],
      }),
    });
    const calls: UpdateCall[] = [];
    const api = spiedApi(base, calls);
    const bootstrap = await api.getBootstrap();
    const view = bootstrap.views.find((v) => v.layout === "calendar_grid");
    if (!view) throw new Error("no calendar view in the dev bootstrap");
    const { from, to } = rangeFor(view, "2026-11-15");
    const range = await api.getRange({ from, to, viewId: view.id });
    render(<GridHarness api={api} bootstrap={bootstrap} range={range} />);
    const line = [...document.querySelectorAll("button.grid-entry")].find((b) =>
      (b.textContent ?? "").includes("ドラッグ集会"),
    );
    if (!line) throw new Error("no grid line for the seeded event");
    const cellEl = document.querySelector('.grid-cell[data-date="2026-11-24"]');
    if (!cellEl) throw new Error("no grid cell for 2026-11-24");
    document.elementFromPoint = () => cellEl;
    fireEvent.pointerDown(line, { clientX: 10, clientY: 10, button: 0, pointerType: "mouse" });
    fireEvent.pointerMove(window, { clientX: 90, clientY: 60 });
    expect(cellEl.className).toContain("drop-target");
    fireEvent.pointerUp(window);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.id).toBe("ev-drag-grid");
    expect(calls[0]?.event["startsOn"]).toBe("2026-11-24");
    expect(calls[0]?.event["endsOn"]).toBe("2026-11-24");
    expect(calls[0]?.event["title"]).toBe("ドラッグ集会");
  });
});

describe("drag & drop moving in the week timeline (L5)", () => {
  it("moves a timed block to another day, keeping its time", async () => {
    const base = createDevApi();
    const calls: UpdateCall[] = [];
    render(<App api={spiedApi(base, calls)} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "view-timeline-staff" } });
    // The dev fixtures hold a timed lesson on 2026-11-10.
    const block = await waitFor(() => {
      const found = [...document.querySelectorAll("button.timeline-block")].find((b) =>
        (b.textContent ?? "").includes("研究授業"),
      );
      if (!found) throw new Error("no timeline block yet");
      return found as HTMLElement;
    });
    const column = document.querySelector('.timeline-day-column[data-date="2026-11-11"]');
    if (!column) throw new Error("no day column for 2026-11-11");
    dragEntry(block, column);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.event["title"]).toBe("研究授業");
    expect(calls[0]?.event["startsOn"]).toBe("2026-11-11");
    expect(calls[0]?.event["endsOn"]).toBe("2026-11-11");
    expect(calls[0]?.event["time"]).toEqual({
      kind: "clock",
      startsAt: "09:00",
      endsAt: "10:30",
    });
  });
});
