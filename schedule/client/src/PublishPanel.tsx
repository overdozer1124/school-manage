import { useCallback, useEffect, useState } from "react";
import type { ScheduleApi } from "./api";
import { monthLabel } from "./lib";
import type {
  BootstrapData,
  PrintSettingsData,
  PublicationData,
  PublicationDocumentData,
  ViewDefinitionData,
} from "./types";

/**
 * The publishing panel (Issue #40, DESIGN schedule 9.1): issue
 * the displayed view's displayed month as a versioned document,
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
 */
export function PublishPanel({
  bootstrap,
  api,
  view,
  anchor,
  onClose,
}: {
  bootstrap: BootstrapData;
  api: ScheduleApi;
  /** The view the table behind the panel is showing. */
  view: ViewDefinitionData;
  /** A date in the displayed month: the issued month. */
  anchor: string;
  onClose: () => void;
}) {
  const targetMonth = anchor.slice(0, 7);
  const canPublish = bootstrap.permissions.includes("publish");
  const [publications, setPublications] = useState<PublicationData[] | null>(null);
  const [versionLabel, setVersionLabel] = useState("");
  const [note, setNote] = useState("");
  const [settings, setSettings] = useState<PrintSettingsData>(() =>
    initialSettings(view.printSettings),
  );
  const [preview, setPreview] = useState<PublicationDocumentData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPublications(await api.getPublications({ viewId: view.id }));
  }, [api, view.id]);

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
        className="duty-panel publish-panel"
        role="dialog"
        aria-modal="true"
        aria-label="発行と印刷"
      >
        <div className="duty-panel-head">
          <h2>発行・印刷（{view.name}）</h2>
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
            <h3>{monthLabel(anchor)}の新しい版を発行</h3>
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
          {publications === null ? (
            <p>読み込み中…</p>
          ) : publications.length === 0 ? (
            <p className="dim">まだ発行されていません。</p>
          ) : (
            <ul className="publication-list">
              {publications.map((publication) => (
                <li key={publication.id}>
                  <span className="publication-label">{publication.versionLabel}</span>
                  <span className="dim">
                    {publication.targetMonth.slice(0, 4)}年
                    {Number(publication.targetMonth.slice(5, 7))}月・
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
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {preview && (
          <section aria-label="印刷プレビュー">
            <h3>プレビュー（{preview.versionLabel}）</h3>
            <iframe
              className="publish-preview"
              title="印刷プレビュー"
              srcDoc={preview.documentHtml}
            />
          </section>
        )}
      </div>
    </div>
  );
}

/** The form's starting settings: the defaults of DESIGN
 *  schedule 9.1, with the view definition's own print_settings
 *  over them — the same resolution the server applies, so what
 *  the form shows is what an unchanged publish would use. */
function initialSettings(viewSettings: Record<string, unknown> | null): PrintSettingsData {
  const resolved: PrintSettingsData = {
    paper: "A4",
    orientation: "landscape",
    marginMm: 10,
    fontScale: "medium",
  };
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
