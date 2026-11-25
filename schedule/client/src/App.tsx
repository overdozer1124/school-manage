import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  ForbiddenError,
  UnauthorizedError,
  platformLoginUrl,
  type ScheduleApi,
} from "./api";
import { CalendarGrid } from "./CalendarGrid";
import type { CellEditorContext } from "./cells";
import { useEventDrag } from "./drag";
import { DutyPanel } from "./DutyPanel";
import {
  monthLabel,
  publicationPeriodFor,
  publicationPeriodLabel,
  rangeFor,
  stepAnchor,
  undecidedForMonth,
  yearLabel,
} from "./lib";
import { MonthNotesHeader } from "./MonthNotes";
import { PendingPanel } from "./PendingPanel";
import { PublishPanel } from "./PublishPanel";
import { RowsTable, UndecidedSection } from "./RowsTable";
import { SettingsPanel } from "./SettingsPanel";
import { SummaryFailure, SummarySection, SummaryTable } from "./Summary";
import { TransposedTable } from "./TransposedTable";
import { TwoColumnTable } from "./TwoColumnTable";
import { WeekTimeline } from "./WeekTimeline";
import { YearTable } from "./YearTable";
import type { BootstrapData, RangeData, SummaryData } from "./types";

/**
 * The schedule screen (Issue #34): pick a view, move through its
 * months or weeks, and read the L1 / L2 rows table. The L3 year
 * table (year_columns) is drawn too, since Issue #42, the
 * L4 calendar grid (calendar_grid) since Issue #43, the
 * L5 week timeline (week_timeline) since Issue #44, the
 * transposed table since Issue #45, and the two-column
 * student table (two_column) since Issue #46; a view
 * naming a layout still to come can be selected but shows a
 * notice instead of a table (those layouts arrive with their
 * own issues). Cells take direct input (Issue #35): a saved
 * write re-reads the range, so what the table shows is always
 * what the server holds.
 *
 * A 401 from the API sends the person to the platform's login
 * (DESIGN-AUTH-TENANCY 4.8); a 403 shows 「権限がありません」.
 */
export function App({
  api,
  initialAnchor,
  onUnauthorized,
}: {
  api: ScheduleApi;
  /** Tests and screenshots pin the first period; the default is today. */
  initialAnchor?: string;
  /** Tests observe the redirect instead of navigating. */
  onUnauthorized?: () => void;
}) {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [range, setRange] = useState<RangeData | null>(null);
  // The period's derived summary (Issue #47) and its own error:
  // a failed summary read dims only the counts, never the table.
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string>(initialAnchor ?? todayText());
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bumped after a saved write (a cell edit, or a change landed
  // from the duty panel), so the table (and its conflict marks)
  // is read again.
  const [reloadTick, setReloadTick] = useState(0);
  // Bumped when the settings screens save a definition, so the
  // bootstrap (views, items, duties) is read again and the table
  // is drawn from the new definitions (Issue #39).
  const [bootstrapTick, setBootstrapTick] = useState(0);

  const handleError = useCallback(
    (cause: unknown) => {
      if (cause instanceof UnauthorizedError) {
        if (onUnauthorized) onUnauthorized();
        else window.location.assign(platformLoginUrl());
        return;
      }
      if (cause instanceof ForbiddenError) {
        setForbidden(true);
        return;
      }
      setError(
        cause instanceof ApiError || cause instanceof Error
          ? cause.message
          : "読み込みに失敗しました",
      );
    },
    [onUnauthorized],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .getBootstrap()
      .then((result) => {
        if (cancelled) return;
        setBootstrap(result);
        // Archived views are not switch choices (Issue #87): the
        // opening view is the first one on the list, and a view
        // archived while it was open gives its place up too.
        const listed = result.views.filter((v) => !v.isArchived);
        setViewId((current) =>
          current && listed.some((v) => v.id === current) ? current : (listed[0]?.id ?? null),
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) handleError(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [api, handleError, bootstrapTick]);

  const view = useMemo(
    () => bootstrap?.views.find((v) => v.id === viewId) ?? null,
    [bootstrap, viewId],
  );

  useEffect(() => {
    if (!bootstrap || !view) return;
    if (
      view.layout !== "month_rows" &&
      view.layout !== "week_rows" &&
      view.layout !== "year_columns" &&
      view.layout !== "calendar_grid" &&
      view.layout !== "week_timeline" &&
      view.layout !== "transposed" &&
      view.layout !== "two_column"
    ) {
      setRange(null);
      return;
    }
    let cancelled = false;
    const { from, to } = rangeFor(view, anchor);
    api
      .getRange({ from, to, viewId: view.id })
      .then((result) => {
        if (!cancelled) setRange(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) handleError(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [api, bootstrap, view, anchor, reloadTick, handleError]);

  // The summary (Issue #47) is read for the same period as the
  // range, and re-read with it — a saved cell edit bumps
  // reloadTick, and the counts are derived, so they follow the
  // edit. Only the layouts that show it are read: the month
  // tables foot themselves with it and the year table
  // tabulates it. Its failure is kept apart from the range's:
  // the table stays up with a note where the counts would be.
  // A 401 / 403 still goes through handleError, as every read's
  // does (the summary is view.read, like the range).
  //
  // A change of view or period clears the counts before the
  // new read starts, so the previous period's summary never
  // sits under the new table while it loads; a re-read of the
  // same period (a saved edit) keeps them until they land.
  const summaryPeriodRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bootstrap || !view) return;
    if (
      view.layout !== "month_rows" &&
      view.layout !== "two_column" &&
      view.layout !== "year_columns"
    ) {
      summaryPeriodRef.current = null;
      setSummary(null);
      setSummaryError(null);
      return;
    }
    let cancelled = false;
    const { from, to } = rangeFor(view, anchor);
    const periodKey = `${view.id}:${from}:${to}`;
    if (summaryPeriodRef.current !== periodKey) {
      summaryPeriodRef.current = periodKey;
      setSummary(null);
      setSummaryError(null);
    }
    api
      .getSummary({ from, to, viewId: view.id })
      .then((result) => {
        if (cancelled) return;
        setSummary(result);
        setSummaryError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthorizedError || cause instanceof ForbiddenError) {
          handleError(cause);
          return;
        }
        setSummary(null);
        setSummaryError(cause instanceof Error ? cause.message : "集計の読み込みに失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [api, bootstrap, view, anchor, reloadTick, handleError]);

  const editor = useMemo<CellEditorContext>(
    () => ({
      api,
      onSaved: () => setReloadTick((t) => t + 1),
      onUnauthorizedError: () => handleError(new UnauthorizedError()),
    }),
    [api, handleError],
  );

  // Drag & drop moving of events (Issue #50): one drag context
  // for the whole screen, shared by every layout — a move is an
  // event update through the editor's relay, and its failure
  // notice stands under the header.
  const drag = useEventDrag(editor);

  // A failed move's notice belongs to the view and period it
  // happened in (Issue #125): switching either clears it, so
  // it never trails the reader onto an unrelated table. The
  // reader can also close it where it stands.
  const clearDragNotice = drag.clearNotice;
  useEffect(() => {
    clearDragNotice();
  }, [clearDragNotice, viewId, anchor]);

  if (forbidden) {
    return (
      <main className="schedule-app">
        <p className="forbidden" role="alert">
          権限がありません
        </p>
      </main>
    );
  }
  if (error) {
    return (
      <main className="schedule-app">
        <p className="load-error" role="alert">
          {error}
        </p>
      </main>
    );
  }
  if (!bootstrap) {
    return (
      <main className="schedule-app">
        <p>読み込み中…</p>
      </main>
    );
  }
  if (!view) {
    // The bootstrap arrived but no view is on the list — every
    // view is archived (Issue #87), or none was ever defined.
    // Say so instead of loading forever, and keep the settings
    // reachable: bringing a view back is done there.
    return (
      <main className="schedule-app">
        <p>表示できるビューがありません。設定でビューを一覧に戻してください。</p>
        {bootstrap.permissions.includes("definition.write") && (
          <button type="button" onClick={() => setSettingsOpen(true)}>
            設定
          </button>
        )}
        {settingsOpen && (
          <SettingsPanel
            bootstrap={bootstrap}
            api={api}
            onClose={() => setSettingsOpen(false)}
            onChanged={() => {
              setBootstrapTick((t) => t + 1);
              setReloadTick((t) => t + 1);
            }}
          />
        )}
      </main>
    );
  }

  const rowsLayout = view.layout === "month_rows" || view.layout === "week_rows";
  const supported =
    rowsLayout ||
    view.layout === "year_columns" ||
    view.layout === "calendar_grid" ||
    view.layout === "week_timeline" ||
    view.layout === "transposed" ||
    view.layout === "two_column";
  // A transposed view's days are its columns, so a week-scoped
  // one is labelled by its range, like the week layouts; a
  // month- or year-scoped one takes the month / year label.
  const transposedWeek =
    view.layout === "transposed" &&
    (view.periodScope === "week" || view.periodScope === "two_weeks");

  return (
    <main className="schedule-app">
      <header className="app-header">
        <h1>{bootstrap.school.name ?? "行事予定"}</h1>
        <div className="controls">
          <label>
            ビュー{" "}
            <select aria-label="ビュー" value={view.id} onChange={(e) => setViewId(e.target.value)}>
              {bootstrap.views
                .filter((v) => !v.isArchived)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="period-nav">
            <button
              type="button"
              aria-label="前へ"
              onClick={() => setAnchor((a) => stepAnchor(view, a, -1))}
            >
              ← 前
            </button>
            <span className="period-label">
              {view.layout === "week_rows" || view.layout === "week_timeline" || transposedWeek
                ? `${range ? `${range.from} 〜 ${range.to}` : ""}`
                : view.layout === "year_columns" ||
                    (view.layout === "transposed" && view.periodScope === "year")
                  ? yearLabel(anchor)
                  : monthLabel(anchor)}
            </span>
            <button
              type="button"
              aria-label="次へ"
              onClick={() => setAnchor((a) => stepAnchor(view, a, 1))}
            >
              次 →
            </button>
          </div>
          {rowsLayout && range && view.audience === "staff" && (
            <button type="button" onClick={() => setPanelOpen(true)}>
              当番・競合
              {range.conflicts.length > 0 && `（警告${range.conflicts.length}件）`}
            </button>
          )}
          {/* The confirmation queue is the editors' work list
              (DESIGN-AUTH-TENANCY 4.6): offered to Editor and
              Admin, never to Viewer. The settings screens are
              Admin's (definition.write). Both are display
              choices here — the server checks every action. */}
          {(bootstrap.role === "Editor" || bootstrap.role === "Admin") && (
            <button type="button" onClick={() => setPendingOpen(true)}>
              確認待ち
            </button>
          )}
          {bootstrap.permissions.includes("definition.write") && (
            <button type="button" onClick={() => setSettingsOpen(true)}>
              設定
            </button>
          )}
          {/* Issuing and the version list (Issue #40): the list
              and the preview are view.read, open to every role;
              the publish form inside is offered only to holders
              of the publish permission, and the server checks
              it again on the action. */}
          {/* Issuing covers the paper layouts: the month / week
              rows tables, the two-column student table (Issue
              #46: the printed sheet is the layout's reason to
              exist), and — Issue #49 — the year table and the
              month calendar. The week timeline and the transposed
              table stay screen forms and are not issued. */}
          {(rowsLayout ||
            view.layout === "two_column" ||
            view.layout === "year_columns" ||
            view.layout === "calendar_grid") && (
            <button type="button" onClick={() => setPublishOpen(true)}>
              発行・印刷
            </button>
          )}
        </div>
      </header>

      {drag.notice && (
        <p className="move-notice" role="alert">
          {drag.notice}{" "}
          <button type="button" aria-label="お知らせを閉じる" onClick={drag.clearNotice}>
            閉じる
          </button>
        </p>
      )}
      {!supported && (
        <p className="unsupported">このレイアウト（{view.layout}）は今後の Issue で対応します。</p>
      )}
      {supported && range && view.layout === "year_columns" && (
        <YearTable bootstrap={bootstrap} range={range} editor={editor} drag={drag} />
      )}
      {supported && range && view.layout === "year_columns" && summary && (
        <SummaryTable summary={summary} />
      )}
      {supported && range && view.layout === "calendar_grid" && (
        <CalendarGrid
          bootstrap={bootstrap}
          range={range}
          anchor={anchor}
          editor={editor}
          drag={drag}
        />
      )}
      {supported && range && view.layout === "week_timeline" && (
        <WeekTimeline bootstrap={bootstrap} range={range} editor={editor} drag={drag} />
      )}
      {supported && range && view.layout === "transposed" && (
        <TransposedTable bootstrap={bootstrap} range={range} editor={editor} />
      )}
      {rowsLayout && range && (
        <>
          <RowsTable bootstrap={bootstrap} range={range} editor={editor} drag={drag} />
          <UndecidedSection events={undecidedForMonth(range, anchor)} />
          {view.layout === "month_rows" && summary && (
            <SummarySection period={summary.months[0] ?? summary.total} />
          )}
        </>
      )}
      {supported && range && view.layout === "two_column" && (
        <>
          <MonthNotesHeader
            key={`${range.view.id}:${anchor.slice(0, 7)}`}
            range={range}
            anchor={anchor}
            api={api}
            canEdit={bootstrap.permissions.includes("daily.write")}
            onSaved={editor.onSaved}
          />
          <TwoColumnTable bootstrap={bootstrap} range={range} editor={editor} drag={drag} />
          <UndecidedSection events={undecidedForMonth(range, anchor)} />
          {summary && <SummarySection period={summary.months[0] ?? summary.total} />}
        </>
      )}
      {supported &&
        range &&
        !summary &&
        summaryError &&
        (view.layout === "month_rows" ||
          view.layout === "two_column" ||
          view.layout === "year_columns") && <SummaryFailure message={summaryError} />}
      {supported && !range && <p>読み込み中…</p>}
      {panelOpen && range && (
        <DutyPanel
          bootstrap={bootstrap}
          range={range}
          api={api}
          onClose={() => setPanelOpen(false)}
          onChanged={() => setReloadTick((t) => t + 1)}
        />
      )}
      {pendingOpen && (
        <PendingPanel
          bootstrap={bootstrap}
          api={api}
          onClose={() => setPendingOpen(false)}
          onChanged={() => setReloadTick((t) => t + 1)}
        />
      )}
      {publishOpen && (
        <PublishPanel
          bootstrap={bootstrap}
          api={api}
          view={view}
          period={publicationPeriodFor(view, anchor)}
          periodLabel={publicationPeriodLabel(view, publicationPeriodFor(view, anchor))}
          onClose={() => setPublishOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          bootstrap={bootstrap}
          api={api}
          onClose={() => setSettingsOpen(false)}
          onChanged={() => {
            setBootstrapTick((t) => t + 1);
            setReloadTick((t) => t + 1);
          }}
        />
      )}
      {drag.ghost && (
        <div
          className="drag-ghost"
          style={{ left: drag.ghost.x, top: drag.ghost.y }}
          aria-hidden="true"
        >
          {drag.ghost.label}
        </div>
      )}
    </main>
  );
}

function todayText(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
