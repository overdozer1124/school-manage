import { useCallback, useEffect, useId, useState } from "react";
import type { ScheduleApi } from "./api";
import { monthEndOf, publicationPeriodLabel, publicationPeriodOf } from "./lib";
import { useDialogFocus } from "./useDialogFocus";
import type {
  BootstrapData,
  PrintSettingsData,
  PublicationData,
  PublicationDiffData,
  PublicationDocumentData,
  ViewDefinitionData,
} from "./types";

/**
 * The publishing panel (Issue #40, DESIGN schedule 9.1): issue
 * the displayed view's displayed period as a versioned document,
 * list the versions issued so far, preview one, and print it.
 *
 * Issuing renders the document on the server and stores it with
 * the version record; what this panel previews and prints is
 * always that stored document, never a fresh rendering — so a
 * copy handed out last week and the preview of its version show
 * the same table even after the data has moved on. To hand out
 * a corrected table, issue a new version.
 *
 * The form is offered only to holders of the publish permission
 * (Admin and Editor); the list and the preview are view.read,
 * open to every role. As everywhere in these screens, the
 * display choice is not the guard — the server checks the
 * publish permission on createPublication itself.
 *
 * Issue #48 grows the list into the version history: it filters
 * by month; a version's label and note can be corrected in
 * place (the document never changes); a version can be
 * cancelled, which keeps its row, badged 取り消し； and each
 * version can be read against the one issued before it — the
 * days and items that changed, and only those.
 *
 * Issue #49 issues the other paper layouts from this panel:
 * the caller hands over the period the screen is showing (a
 * month, a week table's span, a year table's school year), the
 * form heads itself with it and sends it with the publish, and
 * a history row names its version's period whenever it is not
 * a plain month. The month filter stays: every version's
 * target month is the month its period starts in.
 */
export function PublishPanel({
  bootstrap,
  api,
  view,
  period,
  periodLabel,
  onClose,
}: {
  bootstrap: BootstrapData;
  api: ScheduleApi;
  /** The view the table behind the panel is showing. */
  view: ViewDefinitionData;
  /** The period the screen is showing: the issued span. */
  period: { from: string; to: string };
  /** The period as the form names it （月／週の範囲／年度）. */
  periodLabel: string;
  onClose: () => void;
}) {
  // The shared dialog discipline (Issue #89): initial focus,
  // the Tab trap, Esc to close and focus restoration on close
  // live in useDialogFocus.
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  const headingId = useId();
  const targetMonth = period.from.slice(0, 7);
  const canPublish = bootstrap.permissions.includes("publish");
  const [publications, setPublications] = useState<PublicationData[] | null>(null);
  const [versionLabel, setVersionLabel] = useState("");
  const [note, setNote] = useState("");
  const [settings, setSettings] = useState<PrintSettingsData>(() =>
    initialSettings(view.printSettings, view.layout),
  );
  const [preview, setPreview] = useState<PublicationDocumentData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Issue #48: the version history's own state — the month
  // filter, the row being edited, the row whose cancellation
  // is being confirmed, and the diff being read.
  const [monthFilter, setMonthFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editNote, setEditNote] = useState("");
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [diff, setDiff] = useState<{
    publicationId: string;
    label: string;
    data: PublicationDiffData;
  } | null>(null);

  const load = useCallback(async () => {
    setPublications(
      await api.getPublications({
        viewId: view.id,
        ...(monthFilter ? { targetMonth: monthFilter } : {}),
      }),
    );
  }, [api, view.id, monthFilter]);

  useEffect(() => {
    let cancelled = false;
    load().catch((cause: unknown) => {
      if (!cancelled) setError(errorText(cause, "発行済みの一覧を読み込めませんでした"));
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const publish = async () => {
    const label = versionLabel.trim();
    if (!label || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.createPublication({
        viewId: view.id,
        targetMonth,
        from: period.from,
        to: period.to,
        versionLabel: label,
        note: note.trim() === "" ? null : note.trim(),
        printSettings: settings,
      });
      setVersionLabel("");
      setNote("");
      setNotice(`「${created.versionLabel}」を発行しました`);
      await load();
    } catch (cause) {
      setError(errorText(cause, "発行できませんでした"));
    } finally {
      setBusy(false);
    }
  };

  const showPreview = async (id: string) => {
    setError(null);
    try {
      setPreview(await api.getPublication({ id }));
    } catch (cause) {
      setError(errorText(cause, "文書を読み込めませんでした"));
    }
  };

  const startEdit = (publication: PublicationData) => {
    setEditingId(publication.id);
    setEditLabel(publication.versionLabel);
    setEditNote(publication.snapshotNote ?? "");
    setConfirmCancelId(null);
  };

  /** Corrects a version's label and note (Issue #48). The
   *  stored document is not part of the call and never changes;
   *  the server refuses the edit on a cancelled version. */
  const saveEdit = async (id: string) => {
    const label = editLabel.trim();
    if (!label || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.updatePublication({
        id,
        versionLabel: label,
        note: editNote.trim() === "" ? null : editNote.trim(),
      });
      setEditingId(null);
      setNotice(`「${updated.versionLabel}」のラベルとメモを直しました`);
      await load();
    } catch (cause) {
      setError(errorText(cause, "ラベルとメモを直せませんでした"));
    } finally {
      setBusy(false);
    }
  };

  /** Cancels a version (Issue #48): the record stays in the
   *  list, badged as cancelled; the document stays readable. */
  const cancelVersion = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.cancelPublication({ id });
      setConfirmCancelId(null);
      setNotice(`「${updated.versionLabel}」を取り消しました`);
      await load();
    } catch (cause) {
      setError(errorText(cause, "取り消せませんでした"));
    } finally {
      setBusy(false);
    }
  };

  const showDiff = async (publication: PublicationData) => {
    setError(null);
    try {
      const data = await api.getPublicationDiff({ id: publication.id });
      setDiff({ publicationId: publication.id, label: publication.versionLabel, data });
    } catch (cause) {
      setError(errorText(cause, "違いを読み込めませんでした"));
    }
  };

  /** Prints the stored document: it is opened as its own page
   *  (its @page rules carry the paper, orientation, margins and
   *  page numbers) and the browser's print dialog takes it from
   *  there — saving as PDF is the same dialog's choice. */
  const print = async (id: string) => {
    setError(null);
    try {
      const doc = preview?.id === id ? preview : await api.getPublication({ id });
      const win = window.open("", "_blank");
      if (!win) {
        setError("印刷用の画面を開けませんでした。ポップアップの許可を確認してください。");
        return;
      }
      win.document.open();
      win.document.write(doc.documentHtml);
      win.document.close();
      win.focus();
      win.onload = () => win.print();
    } catch (cause) {
      setError(errorText(cause, "文書を読み込めませんでした"));
    }
  };

  return (
    <div className="duty-panel-overlay">
      <div
        ref={dialogRef}
        className="duty-panel publish-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        <div className="duty-panel-head">
          <h2 id={headingId}>発行・印刷（{view.name}）</h2>
          <button type="button" aria-label="閉じる" onClick={onClose}>
            閉じる
          </button>
        </div>

        {error && (
          <p className="duty-panel-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="duty-panel-notice">{notice}</p>}

        {canPublish && (
          <section aria-label="新しい版を発行">
            <h3>{periodLabel}の新しい版を発行</h3>
            <div className="publish-form">
              <label>
                版ラベル{" "}
                <input
                  aria-label="版ラベル"
                  value={versionLabel}
                  placeholder="例：11月18日修正"
                  onChange={(e) => setVersionLabel(e.target.value)}
                />
              </label>
              <label>
                メモ{" "}
                <input aria-label="メモ" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <label>
                用紙{" "}
                <select
                  aria-label="用紙"
                  value={settings.paper}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      paper: e.target.value as PrintSettingsData["paper"],
                    }))
                  }
                >
                  <option value="A4">A4</option>
                  <option value="A3">A3</option>
                </select>
              </label>
              <label>
                向き{" "}
                <select
                  aria-label="向き"
                  value={settings.orientation}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      orientation: e.target.value as PrintSettingsData["orientation"],
                    }))
                  }
                >
                  <option value="landscape">横</option>
                  <option value="portrait">縦</option>
                </select>
              </label>
              <label>
                文字の大きさ{" "}
                <select
                  aria-label="文字の大きさ"
                  value={settings.fontScale}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      fontScale: e.target.value as PrintSettingsData["fontScale"],
                    }))
                  }
                >
                  <option value="small">小</option>
                  <option value="medium">中</option>
                  <option value="large">大</option>
                </select>
              </label>
              <label>
                余白（mm）{" "}
                <input
                  aria-label="余白"
                  type="number"
                  min={5}
                  max={30}
                  value={settings.marginMm}
                  onChange={(e) => setSettings((s) => ({ ...s, marginMm: Number(e.target.value) }))}
                />
              </label>
            </div>
            <button
              type="button"
              className="accent-button"
              disabled={busy || versionLabel.trim() === ""}
              onClick={() => void publish()}
            >
              発行する
            </button>
            <p className="dim">
              発行した文書は、あとでデータを直しても変わりません。直した表を配るときは、新しい版を発行してください。
            </p>
          </section>
        )}

        <section aria-label="発行済みの一覧">
          <h3>発行済み</h3>
          <div className="publication-filter">
            <label>
              月で絞り込む{" "}
              <input
                type="month"
                aria-label="月で絞り込む"
                value={monthFilter}
                onChange={(e) => setMonthFilter(e.target.value)}
              />
            </label>
            {monthFilter && (
              <button type="button" onClick={() => setMonthFilter("")}>
                絞り込みをやめる
              </button>
            )}
          </div>
          {publications === null ? (
            <p>読み込み中…</p>
          ) : publications.length === 0 ? (
            <p className="dim">
              {monthFilter ? "その月はまだ発行されていません。" : "まだ発行されていません。"}
            </p>
          ) : (
            <ul className="publication-list">
              {publications.map((publication) => (
                <li
                  key={publication.id}
                  className={publication.cancelledAt ? "publication-cancelled-row" : undefined}
                >
                  <span className="publication-label">{publication.versionLabel}</span>
                  {publication.cancelledAt && (
                    <span className="publication-cancelled-badge">取り消し</span>
                  )}
                  <span className="dim">
                    {periodRowText(view, publication)}
                    {new Date(publication.publishedAt).toLocaleString("ja-JP")} 発行
                    {publication.snapshotNote ? `・${publication.snapshotNote}` : ""}
                  </span>
                  <span className="publication-actions">
                    <button type="button" onClick={() => void showPreview(publication.id)}>
                      プレビュー
                    </button>
                    <button type="button" onClick={() => void print(publication.id)}>
                      印刷／PDF
                    </button>
                    <button type="button" onClick={() => void showDiff(publication)}>
                      前の版との違い
                    </button>
                    {canPublish && !publication.cancelledAt && (
                      <>
                        <button type="button" onClick={() => startEdit(publication)}>
                          ラベル・メモを編集
                        </button>
                        {confirmCancelId === publication.id ? (
                          <span className="publication-cancel-confirm">
                            取り消しますか？
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void cancelVersion(publication.id)}
                            >
                              取り消す
                            </button>
                            <button type="button" onClick={() => setConfirmCancelId(null)}>
                              やめる
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmCancelId(publication.id);
                              setEditingId(null);
                            }}
                          >
                            取り消す
                          </button>
                        )}
                      </>
                    )}
                  </span>
                  {editingId === publication.id && (
                    <span className="publication-edit-form">
                      <label>
                        版ラベル{" "}
                        <input
                          aria-label="版ラベル（編集）"
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                        />
                      </label>
                      <label>
                        メモ{" "}
                        <textarea
                          aria-label="メモ（編集）"
                          rows={2}
                          value={editNote}
                          onChange={(e) => setEditNote(e.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={busy || editLabel.trim() === ""}
                        onClick={() => void saveEdit(publication.id)}
                      >
                        保存する
                      </button>
                      <button type="button" onClick={() => setEditingId(null)}>
                        やめる
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {diff && (
          <section aria-label="前の版との違い" className="publication-diff">
            <h3>前の版との違い（{diff.label}）</h3>
            {!diff.data.comparable ? (
              <p className="dim">この版は古い形式のため、違いを比べられません</p>
            ) : diff.data.fromId === null ? (
              <p className="dim">前の版がありません</p>
            ) : (diff.data.changes ?? []).length === 0 ? (
              <p className="dim">前の版から変わった日はありません</p>
            ) : (
              (diff.data.changes ?? []).map((day) => (
                <div key={day.date} className="publication-diff-day">
                  <h4>{dateHeading(day.date)}</h4>
                  <ul>
                    {day.dayType && (
                      <li>
                        日の種別：{dayTypeName(day.dayType.before)} →{" "}
                        {dayTypeName(day.dayType.after)}
                      </li>
                    )}
                    {day.cells.map((cell) => (
                      <li key={cell.columnId}>
                        {cell.label}：
                        <span className="publication-diff-text">
                          {cell.before === "" ? "（なし）" : cell.before}
                        </span>{" "}
                        →{" "}
                        <span className="publication-diff-text">
                          {cell.after === "" ? "（なし）" : cell.after}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        )}

        {preview && (
          <section aria-label="印刷プレビュー">
            <h3>プレビュー（{preview.versionLabel}）</h3>
            <iframe
              className="publish-preview"
              title="印刷プレビュー"
              sandbox=""
              srcDoc={preview.documentHtml}
            />
          </section>
        )}
      </div>
    </div>
  );
}

/** One history row's period words (Issue #49): a plain month
 *  reads as the month it has always read as; any other period
 *  — a week span, a school year — is named as the panel names
 *  periods, so a week version is not mistaken for its month. */
function periodRowText(view: ViewDefinitionData, publication: PublicationData): string {
  const period = publicationPeriodOf(publication);
  const plainMonth =
    period.from === `${publication.targetMonth}-01` && period.to === monthEndOf(period.from);
  if (plainMonth) {
    return `${publication.targetMonth.slice(0, 4)}年${Number(publication.targetMonth.slice(5, 7))}月・`;
  }
  return `${publicationPeriodLabel(view, period)}・`;
}

/** The form's starting settings: the layout's defaults (DESIGN
 *  schedule 9.1; Issue #49: the year table is A3 landscape, the
 *  month calendar A4 portrait), with the view definition's own
 *  print_settings over them — the same resolution the server
 *  applies, so what the form shows is what an unchanged publish
 *  would use. */
function initialSettings(
  viewSettings: Record<string, unknown> | null,
  layout: string,
): PrintSettingsData {
  const resolved: PrintSettingsData = {
    paper: "A4",
    orientation: "landscape",
    marginMm: 10,
    fontScale: "medium",
  };
  if (layout === "year_columns") {
    resolved.paper = "A3";
    resolved.orientation = "landscape";
  }
  if (layout === "calendar_grid") {
    resolved.paper = "A4";
    resolved.orientation = "portrait";
  }
  if (!viewSettings) return resolved;
  if (viewSettings["paper"] === "A4" || viewSettings["paper"] === "A3") {
    resolved.paper = viewSettings["paper"];
  }
  if (viewSettings["orientation"] === "landscape" || viewSettings["orientation"] === "portrait") {
    resolved.orientation = viewSettings["orientation"];
  }
  if (
    typeof viewSettings["marginMm"] === "number" &&
    viewSettings["marginMm"] >= 5 &&
    viewSettings["marginMm"] <= 30
  ) {
    resolved.marginMm = viewSettings["marginMm"];
  }
  if (
    viewSettings["fontScale"] === "small" ||
    viewSettings["fontScale"] === "medium" ||
    viewSettings["fontScale"] === "large"
  ) {
    resolved.fontScale = viewSettings["fontScale"];
  }
  return resolved;
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** 「2026年11月19日」 for one diff day's "YYYY-MM-DD". */
function dateHeading(date: string): string {
  return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

/**
 * The day-type names a diff speaks in (Issue #48): every code
 * named, a class day included — the tables' own label map
 * (lib.ts) leaves a class day blank as a table's unmarked
 * default, which would read as a missing name in a change
 * list, so this map follows the summary's (Summary.tsx) and
 * adds the remaining codes from lib.ts's map.
 */
const DIFF_DAY_TYPE_LABELS: Record<string, string> = {
  class_day: "授業日",
  event_day: "行事日",
  attendance_day: "登校日",
  exam_day: "試験日",
  closed_day: "休業日",
  long_vacation: "長期休業",
  make_up_day: "振替授業日",
};

function dayTypeName(code: string): string {
  if (code === "") return "（なし）";
  return DIFF_DAY_TYPE_LABELS[code] ?? code;
}
