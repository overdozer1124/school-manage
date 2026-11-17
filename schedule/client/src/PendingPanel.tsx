import { useCallback, useEffect, useState } from "react";
import { ApiError, type ScheduleApi } from "./api";
import { absenceKindLabel, dayLabel, pendingRange, staffName } from "./lib";
import type { BootstrapData, PendingRecord } from "./types";

/**
 * The confirmation queue (Issue #39, DESIGN-AUTH-TENANCY 4.6):
 * the tentative absences and events an Editor or Admin settles
 * by confirming or deleting — the two choices 4.6 allows, with
 * no approval workflow around them. Absences come from the
 * platform's pending list (Issue #25: its confirm stamps
 * confirmed_by / confirmed_at); events come from the relay's
 * range read (the platform has no event queue), and confirming
 * one stamps the same record on the event (Issue #85) — a
 * provisional entry of Issue #35 (a placeholder name, or a
 * title-only trip) stays an event until a roster name replaces
 * the typed name in the cell, exactly as ODN's use-case ruling
 * prescribes. Who confirmed a settled entry, and when, is shown
 * in its detail modal.
 *
 * The screen shows the queue only to Editor and Admin (the App
 * offers the button by role); the guard that matters is the
 * server's — the platform refuses the pending list and the
 * confirms to anyone who is not a writer in either product.
 */
export function PendingPanel({
  bootstrap,
  api,
  onClose,
  onChanged,
}: {
  bootstrap: BootstrapData;
  api: ScheduleApi;
  onClose: () => void;
  /** A settled entry changed the table behind the panel. */
  onChanged: () => void;
}) {
  const [absences, setAbsences] = useState<PendingRecord[] | null>(null);
  const [events, setEvents] = useState<PendingRecord[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [absenceResult, eventResult] = await Promise.all([
      api.getPendingAbsences(),
      api.getPendingEvents(pendingRange(todayText())),
    ]);
    setAbsences(absenceResult.items);
    setEvents(eventResult.items);
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    load().catch((cause: unknown) => {
      if (!cancelled) setError(errorText(cause, "確認待ちの一覧を読み込めませんでした"));
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  /** Runs one settle action; a 409 means someone else settled
   *  the entry first, so the queue is read again instead of
   *  leaving a stale row with buttons that cannot work. */
  const settle = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await action();
      setAbsences((list) => (list ?? []).filter((r) => r["id"] !== id));
      setEvents((list) => (list ?? []).filter((r) => r["id"] !== id));
      onChanged();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setNotice("ほかの人が先に処理しました。一覧を更新しました。");
        await load().catch(() => undefined);
      } else {
        setError(errorText(cause, "処理できませんでした"));
      }
    } finally {
      setBusyId(null);
    }
  };

  const revisionOf = (record: PendingRecord): number =>
    typeof record["revision"] === "number" ? (record["revision"] as number) : 1;

  return (
    <div className="duty-panel-overlay">
      <div className="duty-panel" role="dialog" aria-modal="true" aria-label="確認待ち">
        <div className="duty-panel-head">
          <h2>確認待ちの一覧</h2>
          <button type="button" aria-label="閉じる" onClick={onClose}>
            閉じる
          </button>
        </div>
        <p className="dim">
          仮のまま登録されている不在と予定です。内容が正しければ「確定」、誤りなら「削除」のどちらかで処理します。
        </p>
        {error && (
          <p className="duty-panel-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="cell-notice">{notice}</p>}
        {absences === null || events === null ? (
          <p>読み込み中…</p>
        ) : absences.length === 0 && events.length === 0 ? (
          <p>確認待ちはありません。</p>
        ) : (
          <>
            {absences.length > 0 && (
              <section>
                <h3>不在（{absences.length}件）</h3>
                <ul className="change-list">
                  {absences.map((absence) => {
                    const id = String(absence["id"]);
                    return (
                      <li key={id}>
                        <span>
                          {dayLabel(String(absence["fromDate"]))}
                          {absence["toDate"] !== absence["fromDate"] &&
                            ` 〜 ${dayLabel(String(absence["toDate"]))}`}
                          ：{absenceKindLabel(String(absence["kind"]))}：
                          {staffName(bootstrap, String(absence["staffId"]))}
                          {typeof absence["purpose"] === "string" &&
                            `（${absence["purpose"] as string}）`}
                          {typeof absence["subdivisionKey"] === "string" &&
                            `［${absence["subdivisionKey"] as string}］`}
                        </span>{" "}
                        <button
                          type="button"
                          className="accent-button"
                          disabled={busyId !== null}
                          onClick={() =>
                            void settle(id, () =>
                              api.confirmAbsence({ id, revision: revisionOf(absence) }),
                            )
                          }
                        >
                          確定
                        </button>{" "}
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() =>
                            void settle(id, () =>
                              api.deleteAbsence({ id, revision: revisionOf(absence) }),
                            )
                          }
                        >
                          削除
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {events.length > 0 && (
              <section>
                <h3>予定（{events.length}件）</h3>
                <ul className="change-list">
                  {events.map((event) => {
                    const id = String(event["id"]);
                    const provisional = event["kind"] === "other" && event["kindLabel"] != null;
                    return (
                      <li key={id}>
                        <span>
                          {typeof event["startsOn"] === "string"
                            ? dayLabel(event["startsOn"] as string)
                            : "日付未定"}
                          ：{String(event["title"] ?? "")}
                          {provisional && (
                            <span className="dim">
                              （仮の予定：{String(event["kindLabel"])}の担当が未確定です）
                            </span>
                          )}
                          {event["datePrecision"] === "month" && (
                            <span className="dim">（日は未定）</span>
                          )}
                          {event["datePrecision"] === "undecided" && (
                            <span className="dim">（時期は未定）</span>
                          )}
                        </span>{" "}
                        <button
                          type="button"
                          className="accent-button"
                          disabled={busyId !== null}
                          onClick={() =>
                            void settle(id, () =>
                              api.confirmEvent({ id, revision: revisionOf(event) }),
                            )
                          }
                        >
                          確定
                        </button>{" "}
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() =>
                            void settle(id, () =>
                              api.deleteEvent({ id, revision: revisionOf(event) }),
                            )
                          }
                        >
                          削除
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function todayText(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
