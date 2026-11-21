import { useEffect, useMemo, useState } from "react";
import { ApiError, UnauthorizedError, type PublicApi } from "./api";
import { monthLabel, rangeFor, stepAnchor, undecidedForMonth, yearLabel } from "./lib";
import { RowsTable, UndecidedSection } from "./RowsTable";
import { YearTable } from "./YearTable";
import type { BootstrapData, PublicBootstrapData, RangeData } from "./types";

function todayText(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The public viewing screen (Issue #41). Whoever holds the URL
// reads the one view the token was issued for — no account, no
// sign-in — and nothing else: the bundle the server hands over
// is already stripped to that view's audience (no duties, no
// names, no absences), and this screen mounts only the reading
// parts of the month table. No input component exists here, and
// the public client has no write call to make even if one were
// mounted.

/** The public bootstrap, reshaped into the month table's
 *  bootstrap so the display components are shared as-is. The
 *  reader is nobody: no user, no role, no masters of people. */
function asTableBootstrap(boot: PublicBootstrapData): BootstrapData {
  return {
    school: boot.school,
    userId: "",
    teacherId: null,
    role: "",
    permissions: [],
    views: [boot.view],
    itemDefinitions: boot.itemDefinitions,
    targetGroups: boot.targetGroups,
    kindTemplates: [],
    dutyDefinitions: [],
    locations: [],
    absenceSubdivisions: [],
    inputOpener: "popover",
    masters: { staff: [], grades: boot.grades, dayPatterns: [] },
  };
}

export function PublicApp({ api }: { api: PublicApi }) {
  const [boot, setBoot] = useState<PublicBootstrapData | null>(null);
  const [anchor, setAnchor] = useState<string>(() => todayText());
  const [range, setRange] = useState<RangeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getPublicBootstrap()
      .then((data) => {
        if (!cancelled) setBoot(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A revoked or unknown token, or any other refusal, is
        // the same face to a reader: this URL cannot be used.
        // There is no sign-in to send them to — the URL is the
        // whole credential. The one different face is a 503: the
        // server itself cannot answer now (Issue #82 review), so
        // the reader is told to come back later instead of being
        // told their URL is dead.
        setUnavailable(e instanceof ApiError && e.status === 503);
        setError(
          e instanceof UnauthorizedError || e instanceof ApiError
            ? e.message
            : "読み込めませんでした",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!boot) return;
    let cancelled = false;
    const { from, to } = rangeFor(boot.view, anchor);
    api
      .getPublicRange({ from, to })
      .then((data) => {
        if (cancelled) return;
        setRange(data);
        setRangeError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setRangeError(e instanceof Error ? e.message : "読み込めませんでした");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, boot, anchor]);

  const tableBoot = useMemo(() => (boot ? asTableBootstrap(boot) : null), [boot]);

  if (error) {
    if (unavailable) {
      return (
        <div className="schedule-app">
          <main className="notice" role="alert">
            <h1>ただいま表示できません</h1>
            <p>しばらく待ってから、もう一度開いてください。</p>
          </main>
        </div>
      );
    }
    return (
      <div className="schedule-app">
        <main className="notice" role="alert">
          <h1>この公開URLは使えません</h1>
          <p>{error}</p>
          <p>URLが正しいか、配布した学校にご確認ください。</p>
        </main>
      </div>
    );
  }
  if (!boot || !tableBoot) {
    return (
      <div className="schedule-app">
        <main className="notice">読み込み中です…</main>
      </div>
    );
  }

  const view = boot.view;
  const undecided = range ? undecidedForMonth(range, anchor) : [];
  return (
    <div className="schedule-app">
      <header className="app-header">
        <h1>{boot.school.name ?? "学校"} 行事予定</h1>
        <span className="view-name">{view.name}</span>
      </header>
      <div className="controls">
        <div className="period-nav" role="group" aria-label="表示期間">
          <button type="button" onClick={() => setAnchor((a) => stepAnchor(view, a, -1))}>
            ‹ 前へ
          </button>
          <span className="period-label">
            {view.layout === "week_rows"
              ? rangeLabel(range)
              : view.layout === "year_columns"
                ? yearLabel(anchor)
                : monthLabel(anchor)}
          </span>
          <button type="button" onClick={() => setAnchor((a) => stepAnchor(view, a, 1))}>
            次へ ›
          </button>
          <button type="button" onClick={() => setAnchor(todayText())}>
            今日
          </button>
        </div>
      </div>
      {rangeError && (
        <p className="notice" role="alert">
          {rangeError}
        </p>
      )}
      {range ? (
        view.layout === "year_columns" ? (
          // The year table reads the same bundle, without an
          // editor: the public screen mounts no input (Issue
          // #42 draws L3 here too, so a public year view is the
          // year table and not a 366-row month table).
          <YearTable range={range} bootstrap={tableBoot} />
        ) : (
          <>
            <RowsTable range={range} bootstrap={tableBoot} />
            <UndecidedSection events={undecided} />
          </>
        )
      ) : (
        !rangeError && <p className="notice">読み込み中です…</p>
      )}
    </div>
  );
}

function rangeLabel(range: RangeData | null): string {
  if (!range) return "";
  return `${range.from} ～ ${range.to}`;
}
