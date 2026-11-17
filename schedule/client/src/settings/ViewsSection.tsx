import { useEffect, useState } from "react";
import { columnLabel, formatIssuedAt } from "../lib";
import type {
  BootstrapData,
  PublicViewTokenData,
  ViewColumnData,
  ViewDefinitionData,
} from "../types";
import {
  AUDIENCE_LABELS,
  LAYOUT_LABELS,
  PERIOD_SCOPE_LABELS,
  newRowId,
  Section,
  type SectionCtx,
} from "./shared";

/** Views: their columns (add / remove / reorder), audience,
 *  layout, and a header preview of the columns as the table
 *  will head them. */
export function ViewsSection({ ctx }: { ctx: SectionCtx }) {
  const { views, setViews, api, run, busy, deleteButton, bootstrap, defs } = ctx;
  const items = defs?.itemDefinitions ?? [];
  const [form, setForm] = useState<{
    id: string | null;
    name: string;
    layout: string;
    audience: string;
    periodScope: string;
    layoutParams: Record<string, unknown> | null;
    printSettings: Record<string, unknown> | null;
    columns: ViewColumnData[];
  } | null>(null);
  const [addKind, setAddKind] = useState("daily_item");
  const [addRef, setAddRef] = useState("");
  // Archived views (Issue #87) stay out of the everyday list;
  // this section shows them only on request, so a retired view
  // can be managed — and brought back — without crowding the
  // views in use.
  const [showArchived, setShowArchived] = useState(false);
  const listed = views.filter((v) => !v.isArchived);
  const archivedViews = views.filter((v) => v.isArchived);

  const setArchived = (view: ViewDefinitionData, archived: boolean) =>
    void run(async () => {
      const saved = await api.setViewArchived({ id: view.id, archived });
      setViews((list) => list.map((v) => (v.id === saved.id ? saved : v)));
    });

  const openForm = (view: ViewDefinitionData | null) => {
    setForm({
      id: view?.id ?? null,
      name: view?.name ?? "",
      layout: view?.layout ?? "month_rows",
      audience: view?.audience ?? "staff",
      periodScope: view?.periodScope ?? "month",
      layoutParams: view?.layoutParams ?? null,
      printSettings: view?.printSettings ?? null,
      columns: view ? structuredClone(view.columns) : [],
    });
    setAddRef("");
  };

  const previewBootstrap: BootstrapData = {
    ...bootstrap,
    itemDefinitions: items,
    dutyDefinitions: ctx.duties,
  };

  const viewRow = (view: ViewDefinitionData) => (
    <li key={view.id}>
      <span>
        {view.name}
        <span className="dim">
          （{LAYOUT_LABELS[view.layout] ?? view.layout}／
          {AUDIENCE_LABELS[view.audience] ?? view.audience}／
          {PERIOD_SCOPE_LABELS[view.periodScope] ?? view.periodScope}／列{view.columns.length}件
          {view.isArchived && "／一覧から外しています"}）
        </span>
      </span>{" "}
      <button type="button" disabled={busy} onClick={() => openForm(view)}>
        編集
      </button>{" "}
      {view.isArchived ? (
        <button type="button" disabled={busy} onClick={() => setArchived(view, false)}>
          一覧に戻す
        </button>
      ) : (
        <button type="button" disabled={busy} onClick={() => setArchived(view, true)}>
          一覧から外す
        </button>
      )}{" "}
      {deleteButton(
        `view:${view.id}`,
        "削除",
        async () => {
          await api.deleteViewDefinition({ id: view.id });
          setViews((list) => list.filter((v) => v.id !== view.id));
        },
        // Deleting takes the columns and the public-URL records
        // with it, and a view with issued publications cannot be
        // deleted at all; archiving (Issue #87) is the
        // non-destructive way to retire a view.
        "削除すると、このビューの列の定義と公開URLの記録もすべて消えます。発行した版があるビューは削除できません。使うのをやめるだけなら、削除ではなく「一覧から外す」を使ってください。",
      )}
      <PublicUrlBlock ctx={ctx} view={view} />
    </li>
  );

  return (
    <Section title="ビュー（表示の定義）">
      <ul className="settings-list">{listed.map(viewRow)}</ul>
      {archivedViews.length > 0 && (
        <>
          <button type="button" disabled={busy} onClick={() => setShowArchived((s) => !s)}>
            {showArchived
              ? "一覧から外したビューを隠す"
              : `一覧から外したビューを表示（${archivedViews.length}件）`}
          </button>
          {showArchived && <ul className="settings-list">{archivedViews.map(viewRow)}</ul>}
        </>
      )}
      {form === null && (
        <button type="button" disabled={busy} onClick={() => openForm(null)}>
          ビューを追加
        </button>
      )}
      {form && (
        <div className="settings-form">
          <label>
            ビューの名前{" "}
            <input
              aria-label="ビューの名前"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            レイアウト{" "}
            <select
              aria-label="レイアウト"
              value={form.layout}
              onChange={(e) => setForm({ ...form, layout: e.target.value })}
            >
              {Object.entries(LAYOUT_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            受け手{" "}
            <select
              aria-label="受け手"
              value={form.audience}
              onChange={(e) => setForm({ ...form, audience: e.target.value })}
            >
              {Object.entries(AUDIENCE_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            期間{" "}
            <select
              aria-label="期間"
              value={form.periodScope}
              onChange={(e) => setForm({ ...form, periodScope: e.target.value })}
            >
              {Object.entries(PERIOD_SCOPE_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="settings-checks">
            <legend>列（上から順に左から並びます）</legend>
            {form.columns.map((column, i) => (
              <div key={column.id} className="settings-row">
                <span>{columnLabel(column, previewBootstrap)}</span>
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() =>
                    setForm({
                      ...form,
                      columns: form.columns.map((c, j) =>
                        j === i - 1
                          ? column
                          : j === i
                            ? (form.columns[i - 1] as ViewColumnData)
                            : c,
                      ),
                    })
                  }
                >
                  上へ
                </button>
                <button
                  type="button"
                  disabled={i === form.columns.length - 1}
                  onClick={() =>
                    setForm({
                      ...form,
                      columns: form.columns.map((c, j) =>
                        j === i + 1
                          ? column
                          : j === i
                            ? (form.columns[i + 1] as ViewColumnData)
                            : c,
                      ),
                    })
                  }
                >
                  下へ
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setForm({ ...form, columns: form.columns.filter((_, j) => j !== i) })
                  }
                >
                  列を外す
                </button>
              </div>
            ))}
            <div className="settings-row">
              <select
                aria-label="列の種類"
                value={addKind}
                onChange={(e) => {
                  setAddKind(e.target.value);
                  setAddRef("");
                }}
              >
                <option value="event_category">行事（種別ごとの列）</option>
                <option value="daily_item">項目の列</option>
                <option value="duty">当番の列</option>
                <option value="day_attribute">日の種別</option>
              </select>
              {addKind === "daily_item" && (
                <select
                  aria-label="列にする項目"
                  value={addRef}
                  onChange={(e) => setAddRef(e.target.value)}
                >
                  <option value="">項目を選ぶ</option>
                  {items.map((itemDef) => (
                    <option key={itemDef.id} value={itemDef.id}>
                      {itemDef.name}
                    </option>
                  ))}
                </select>
              )}
              {addKind === "duty" && (
                <select
                  aria-label="列にする当番"
                  value={addRef}
                  onChange={(e) => setAddRef(e.target.value)}
                >
                  <option value="">当番を選ぶ</option>
                  {ctx.duties.map((duty) => (
                    <option key={duty.id} value={duty.id}>
                      {duty.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                disabled={(addKind === "daily_item" || addKind === "duty") && addRef === ""}
                onClick={() => {
                  const viewId = form.id ?? "new-view";
                  setForm({
                    ...form,
                    columns: [
                      ...form.columns,
                      {
                        id: newRowId("col"),
                        viewDefinitionId: viewId,
                        sourceKind: addKind as ViewColumnData["sourceKind"],
                        itemDefinitionId: addKind === "daily_item" ? addRef : null,
                        dutyDefinitionId: addKind === "duty" ? addRef : null,
                        targetGroupId: null,
                        groupSameValues: true,
                        widthHint: null,
                        sort: form.columns.length + 1,
                      },
                    ],
                  });
                  setAddRef("");
                }}
              >
                列を足す
              </button>
            </div>
          </fieldset>
          <div>
            <p className="dim">プレビュー（列の見出し）</p>
            <table className="rows-table settings-preview">
              <thead>
                <tr>
                  <th>日付</th>
                  {form.columns.map((column) => (
                    <th key={column.id}>{columnLabel(column, previewBootstrap)}</th>
                  ))}
                </tr>
              </thead>
            </table>
          </div>
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const saved = await api.upsertViewDefinition({
                      id: form.id ?? newRowId("view"),
                      name: form.name,
                      layout: form.layout,
                      layoutParams: form.layoutParams,
                      audience: form.audience,
                      periodScope: form.periodScope,
                      printSettings: form.printSettings,
                      columns: form.columns.map((c, i) => ({
                        id: c.id,
                        sourceKind: c.sourceKind,
                        itemDefinitionId: c.itemDefinitionId,
                        dutyDefinitionId: c.dutyDefinitionId,
                        targetGroupId: c.targetGroupId,
                        groupSameValues: c.groupSameValues,
                        widthHint: c.widthHint,
                        sort: i + 1,
                      })),
                    });
                    setViews((list) => [...list.filter((v) => v.id !== saved.id), saved]);
                  },
                  () => setForm(null),
                )
              }
            >
              ビューを保存
            </button>
            <button type="button" disabled={busy} onClick={() => setForm(null)}>
              やめる
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

/** The view's public URL (Issue #41): issue and revoke the
 *  tokens that open this view to readers with no account. Only
 *  non-staff views can be opened this way — a staff view's URL
 *  would carry duties and names, so the server refuses to issue
 *  one and this block says why instead of offering the button.
 *  An issued token's value is shown exactly once, as the full
 *  URL, in the moment it is issued; afterwards only the record
 *  (when, and whether revoked) remains. */
function PublicUrlBlock({ ctx, view }: { ctx: SectionCtx; view: ViewDefinitionData }) {
  const { api, run, busy, deleteButton } = ctx;
  const [tokens, setTokens] = useState<PublicViewTokenData[] | null>(null);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (view.audience === "staff") return;
    let cancelled = false;
    api
      .getPublicViewTokens({ viewId: view.id })
      .then((rows) => {
        if (!cancelled) setTokens(rows);
      })
      .catch(() => {
        if (!cancelled) setTokens([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, view.id, view.audience]);

  if (view.audience === "staff") {
    return <p className="dim">公開URL：職員用ビューには発行できません</p>;
  }

  const issue = () =>
    void run(async () => {
      const created = await api.createPublicViewToken({ viewId: view.id });
      setTokens((list) => [...(list ?? []), created]);
      setIssuedUrl(publicUrlFor(created.token));
    });

  // Revoking is the settings' two-step button, like a delete:
  //  it takes effect at once and cannot be undone, and the URL
  //  may already be in guardians' hands, so the first click only
  //  arms it and spells that out (Issue #41 review).
  const revokeButton = (token: PublicViewTokenData) =>
    deleteButton(
      `public-token-${token.id}`,
      "無効化",
      async () => {
        const revoked = await api.revokePublicViewToken({ id: token.id });
        setTokens((list) => (list ?? []).map((t) => (t.id === token.id ? revoked : t)));
      },
      "無効化すると、この公開URLは使えなくなります。元に戻すことはできません。",
    );

  return (
    <div className="public-url-block">
      <p className="dim">公開URL：このURLを知っている人は、ログインなしでこのビューを見られます</p>
      {tokens === null ? (
        <p className="dim">読み込み中です…</p>
      ) : tokens.length === 0 ? (
        <p className="dim">まだ発行されていません</p>
      ) : (
        <ul className="settings-list">
          {tokens.map((token) => (
            <li key={token.id}>
              <span>
                {formatIssuedAt(token.createdAt)} 発行
                {token.revokedAt ? (
                  <span className="dim">（{formatIssuedAt(token.revokedAt)} に無効化済み）</span>
                ) : (
                  <span className="dim">（有効）</span>
                )}
              </span>{" "}
              {!token.revokedAt && revokeButton(token)}
            </li>
          ))}
        </ul>
      )}
      <button type="button" disabled={busy} onClick={issue}>
        公開URLを発行
      </button>
      {issuedUrl && (
        <p>
          <label>
            発行した公開URL（このURLは今だけ表示されます。必要な人に渡してください）{" "}
            <input
              aria-label="発行した公開URL"
              readOnly
              value={issuedUrl}
              size={Math.min(issuedUrl.length, 72)}
              onFocus={(e) => e.target.select()}
            />
          </label>{" "}
          <button type="button" onClick={() => setIssuedUrl(null)}>
            閉じる
          </button>
        </p>
      )}
    </div>
  );
}

/** The public page's URL for a token: the app is served under
 *  `/{slug}/schedule/`, and the public page hangs off the same
 *  root as `public-view/{token}`. Only `dev=1` rides along, so a
 *  development page hands over a URL that opens against the same
 *  adapter; the rest of the settings page's query is this
 *  screen's own state and must not leak into a URL the school
 *  hands out (Issue #41 review). */
export function publicUrlFor(token: string): string {
  const { origin, pathname, search } = window.location;
  const marker = "/schedule/";
  const at = pathname.indexOf(marker);
  const root = at >= 0 ? pathname.slice(0, at + marker.length) : pathname.replace(/\/?$/, "/");
  const dev = new URLSearchParams(search).get("dev") === "1" ? "?dev=1" : "";
  return `${origin}${root}public-view/${encodeURIComponent(token)}${dev}`;
}
