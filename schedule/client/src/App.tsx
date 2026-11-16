import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  ForbiddenError,
  UnauthorizedError,
  platformLoginUrl,
  type ScheduleApi,
} from "./api";
import type { CellEditorContext } from "./cells";
import { DutyPanel } from "./DutyPanel";
import { monthLabel, rangeFor, stepAnchor, undecidedForMonth } from "./lib";
import { PendingPanel } from "./PendingPanel";
import { PublishPanel } from "./PublishPanel";
import { RowsTable, UndecidedSection } from "./RowsTable";
import { SettingsPanel } from "./SettingsPanel";
import type { BootstrapData, RangeData } from "./types";

/**
 * The schedule screen (Issue #34): pick a view, move through its
 * months or weeks, and read the L1 / L2 rows table. Only layouts
 * month_rows and week_rows are drawn; a view naming a Phase 2 layout
 * can be selected but shows a notice instead of a table (those
 * layouts arrive with their own issues). Cells take direct input
 * (Issue #35): a saved write re-reads the range, so what the table
 * shows is always what the server holds.
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
        setViewId((current) => current ?? result.views[0]?.id ?? null);
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
    if (view.layout !== "month_rows" && view.layout !== "week_rows") {
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

  const editor = useMemo<CellEditorContext>(
    () => ({
      api,
      onSaved: () => setReloadTick((t) => t + 1),
      onUnauthorizedError: () => handleError(new UnauthorizedError()),
    }),
    [api, handleError],
  );

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
  if (!bootstrap || !view) {
    return (
      <main className="schedule-app">
        <p>読み込み中…</p>
      </main>
    );
  }

  const supported = view.layout === "month_rows" || view.layout === "week_rows";

  return (
    <main className="schedule-app">
      <header className="app-header">
        <h1>{bootstrap.school.name ?? "行事予定"}</h1>
        <div className="controls">
          <label>
            ビュー{" "}
            <select aria-label="ビュー" value={view.id} onChange={(e) => setViewId(e.target.value)}>
              {bootstrap.views.map((v) => (
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
              {view.layout === "week_rows"
                ? `${range ? `${range.from} 〜 ${range.to}` : ""}`
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
          {supported && range && view.audience === "staff" && (
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
          {supported && (
            <button type="button" onClick={() => setPublishOpen(true)}>
              発行・印刷
            </button>
          )}
        </div>
      </header>

      {!supported && (
        <p className="unsupported">このレイアウト（{view.layout}）は今後の Issue で対応します。</p>
      )}
      {supported && range && (
        <>
          <RowsTable bootstrap={bootstrap} range={range} editor={editor} />
          <UndecidedSection events={undecidedForMonth(range, anchor)} />
        </>
      )}
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
          anchor={anchor}
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
