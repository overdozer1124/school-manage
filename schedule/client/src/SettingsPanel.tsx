import { useCallback, useEffect, useState } from "react";
import type { ScheduleApi } from "./api";
import { columnLabel } from "./lib";
import type {
  BootstrapData,
  DefinitionSetData,
  DutyDefinitionData,
  ItemDefinitionData,
  ItemOptionData,
  KindTemplateData,
  LocationData,
  MasterKindData,
  MastersData,
  TargetData,
  TargetGroupData,
  ViewColumnData,
  ViewDefinitionData,
} from "./types";

/**
 * The settings screens (Issue #39), ported from the prototype's
 * SettingsPanel / QuickSetup (school-schedule, frozen) onto this
 * implementation's actions and rebuilt to the screens' own
 * parts: sections down one scroll — presets and school settings,
 * item definitions and their legends, target axes and targets,
 * locations, duty definitions and their rotation rosters, views,
 * kind templates, and the shared masters (edited through the
 * relay to the platform, Issue #22's API).
 *
 * The prototype's school name / school year fields are not here:
 * in this implementation the school is the platform's record,
 * read through /auth/me, not a schedule setting. The publication
 * history section is not here either — publications are a later
 * issue's actions, not settings.
 *
 * Who sees this screen is the App's choice (Admin only, by the
 * definition.write permission); the guard that matters is the
 * server's — every write below is an action whose permission the
 * server checks (definition.write / master.write /
 * school.admin), and the master relay is judged by the platform
 * itself. A refusal surfaces here as the panel's error line.
 */

let fallbackSeq = 0;
/** New definition rows carry a client-made id, as the platform
 *  records do (the input schemas require one). */
function newRowId(prefix: string): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `${prefix}-${cryptoObj.randomUUID()}`;
  }
  fallbackSeq += 1;
  return `${prefix}-${Date.now()}-${fallbackSeq}`;
}

const VALUE_TYPE_LABELS: Record<string, string> = {
  text: "文字",
  event_list: "行事リスト",
  time: "時刻",
  time_range: "時間帯",
  symbol: "記号（選択）",
  code: "コード",
  person: "人（1人）",
  persons: "人（複数）",
  number: "数値",
  boolean: "真偽（○×）",
  target_time_map: "対象別の時刻",
};
const GRANULARITY_LABELS: Record<string, string> = {
  day: "日ごと",
  am_pm: "午前・午後",
  period: "時限ごと",
  week: "週ごと",
  month: "月ごと",
};
const VISIBILITY_LABELS: Record<string, string> = {
  staff_only: "職員のみ",
  guardian: "保護者まで",
  student: "生徒まで",
  public: "公開",
};
const LAYOUT_LABELS: Record<string, string> = {
  month_rows: "月表（行）",
  week_rows: "週表（行）",
  year_columns: "年間表（列）",
  calendar_grid: "カレンダー格子",
  week_timeline: "週タイムライン",
  transposed: "転置表",
};
const AUDIENCE_LABELS: Record<string, string> = {
  staff: "職員",
  guardian: "保護者",
  student: "生徒",
  public: "公開",
};
const PERIOD_SCOPE_LABELS: Record<string, string> = {
  week: "週",
  two_weeks: "2週間",
  month: "月",
  year: "年",
};
const DUTY_PERIOD_LABELS: Record<string, string> = {
  all_year: "通年",
  term: "学期のみ",
  long_vacation_only: "長期休業のみ",
  custom_range: "期間を指定",
};
const ABSENCE_KINDS: { code: string; label: string }[] = [
  { code: "business_trip", label: "出張" },
  { code: "training", label: "研修" },
  { code: "leave", label: "休暇" },
  { code: "other", label: "その他" },
];
const WEEKDAYS: { code: string; label: string }[] = [
  { code: "mon", label: "月" },
  { code: "tue", label: "火" },
  { code: "wed", label: "水" },
  { code: "thu", label: "木" },
  { code: "fri", label: "金" },
  { code: "sat", label: "土" },
  { code: "sun", label: "日" },
];
const STEP_KIND_LABELS: Record<string, string> = {
  person: "担当者",
  location: "場所",
  time: "時間",
  subdivision: "分類",
  item: "追加項目",
};
const PRESETS: {
  key: "elementary_no_bus" | "elementary_bus" | "junior_high";
  label: string;
  note: string;
}[] = [
  {
    key: "elementary_no_bus",
    label: "小学校（バスなし）",
    note: "行事・給食・学年別下校・清掃・放課後",
  },
  {
    key: "elementary_bus",
    label: "小学校（バスあり）",
    note: "バスなし＋スクールバス（便別）・職員動静・〆切・日番の項目",
  },
  { key: "junior_high", label: "中学校", note: "行事・給食・部活動・生徒会・最終下校" },
];

type RunFn = (action: () => Promise<unknown>, done?: () => void) => Promise<void>;

export function SettingsPanel({
  bootstrap,
  api,
  onClose,
  onChanged,
}: {
  bootstrap: BootstrapData;
  api: ScheduleApi;
  onClose: () => void;
  /** A saved setting changed the table behind the panel. */
  onChanged: () => void;
}) {
  const [defs, setDefs] = useState<DefinitionSetData | null>(null);
  const [masters, setMasters] = useState<MastersData | null>(null);
  const [views, setViews] = useState<ViewDefinitionData[]>(bootstrap.views);
  const [duties, setDuties] = useState<DutyDefinitionData[]>(bootstrap.dutyDefinitions);
  const [templates, setTemplates] = useState<KindTemplateData[]>(bootstrap.kindTemplates);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  useEffect(() => {
    setViews(bootstrap.views);
    setDuties(bootstrap.dutyDefinitions);
    setTemplates(bootstrap.kindTemplates);
  }, [bootstrap]);

  const reloadDefinitions = useCallback(async () => {
    setDefs(await api.getDefinitions());
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getDefinitions(), api.getMasters()])
      .then(([definitionSet, masterSet]) => {
        if (cancelled) return;
        setDefs(definitionSet);
        setMasters(masterSet);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "設定を読み込めませんでした");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const run: RunFn = async (action, done) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setConfirmKey(null);
    try {
      await action();
      done?.();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存できませんでした");
    } finally {
      setBusy(false);
    }
  };

  /** A two-step delete button: the first click arms it, the
   *  second (on the same row) deletes. Any other action disarms. */
  const deleteButton = (key: string, label: string, action: () => Promise<unknown>) => (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (confirmKey === key) {
          void run(action);
        } else {
          setConfirmKey(key);
        }
      }}
    >
      {confirmKey === key ? `本当に${label}` : label}
    </button>
  );

  const ctx: SectionCtx = {
    api,
    bootstrap,
    busy,
    run,
    deleteButton,
    defs,
    setDefs,
    masters,
    setMasters,
    views,
    setViews,
    duties,
    setDuties,
    templates,
    setTemplates,
    reloadDefinitions,
    setNotice,
  };

  return (
    <div className="duty-panel-overlay">
      <div className="duty-panel settings-panel" role="dialog" aria-modal="true" aria-label="設定">
        <div className="duty-panel-head">
          <h2>設定・マスタ</h2>
          <button type="button" aria-label="閉じる" onClick={onClose}>
            閉じる
          </button>
        </div>
        {error && (
          <p className="duty-panel-error" role="alert">
            保存できませんでした：{error}
          </p>
        )}
        {notice && <p className="cell-notice">{notice}</p>}
        {defs === null || masters === null ? (
          <p>読み込み中…</p>
        ) : (
          <>
            <PresetSection ctx={ctx} />
            <ItemsSection ctx={ctx} />
            <TargetsSection ctx={ctx} />
            <LocationsSection ctx={ctx} />
            <DutiesSection ctx={ctx} />
            <ViewsSection ctx={ctx} />
            <TemplatesSection ctx={ctx} />
            <MastersSection ctx={ctx} />
          </>
        )}
      </div>
    </div>
  );
}

interface SectionCtx {
  api: ScheduleApi;
  bootstrap: BootstrapData;
  busy: boolean;
  run: RunFn;
  deleteButton: (key: string, label: string, action: () => Promise<unknown>) => React.ReactNode;
  defs: DefinitionSetData | null;
  setDefs: React.Dispatch<React.SetStateAction<DefinitionSetData | null>>;
  masters: MastersData | null;
  setMasters: React.Dispatch<React.SetStateAction<MastersData | null>>;
  views: ViewDefinitionData[];
  setViews: React.Dispatch<React.SetStateAction<ViewDefinitionData[]>>;
  duties: DutyDefinitionData[];
  setDuties: React.Dispatch<React.SetStateAction<DutyDefinitionData[]>>;
  templates: KindTemplateData[];
  setTemplates: React.Dispatch<React.SetStateAction<KindTemplateData[]>>;
  reloadDefinitions: () => Promise<void>;
  setNotice: (text: string | null) => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Presets and the school settings row (input opener, and which
 *  absence kinds count for duty conflicts). */
function PresetSection({ ctx }: { ctx: SectionCtx }) {
  const { defs, api, run, busy, reloadDefinitions, setNotice } = ctx;
  const settings = defs?.settings ?? null;
  const [opener, setOpener] = useState<"popover" | "modal">("popover");
  const [kinds, setKinds] = useState<string[] | null>(null);
  useEffect(() => {
    if (settings) {
      setOpener(settings.inputOpener);
      setKinds(settings.dutyConflictAbsenceKinds);
    }
  }, [settings]);

  return (
    <Section title="プリセットと学校設定">
      <p className="dim">
        プリセットは初期値です。すでに同じキーの項目がある学校では、その項目はそのまま残ります。
      </p>
      <div className="settings-row">
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                async () => {
                  await api.applyPreset({ preset: preset.key });
                  await reloadDefinitions();
                },
                () => setNotice(`プリセット「${preset.label}」を適用しました`),
              )
            }
          >
            {preset.label}を適用
          </button>
        ))}
      </div>
      <p className="dim">{PRESETS.map((p) => `${p.label}：${p.note}`).join("／")}</p>
      <div className="settings-form">
        <label>
          セル入力のあとに開くもの{" "}
          <select
            aria-label="セル入力のあとに開くもの"
            value={opener}
            onChange={(e) => setOpener(e.target.value as "popover" | "modal")}
          >
            <option value="popover">クイック入力ポップオーバー</option>
            <option value="modal">詳細モーダル</option>
          </select>
        </label>
        <fieldset className="settings-checks">
          <legend>当番の競合として数える不在の種別</legend>
          <label>
            <input
              type="checkbox"
              checked={kinds === null}
              onChange={(e) => setKinds(e.target.checked ? null : [])}
            />{" "}
            すべての種別
          </label>
          {ABSENCE_KINDS.map((kind) => (
            <label key={kind.code}>
              <input
                type="checkbox"
                disabled={kinds === null}
                checked={kinds !== null && kinds.includes(kind.code)}
                onChange={(e) =>
                  setKinds((current) => {
                    const base = current ?? [];
                    return e.target.checked
                      ? [...base, kind.code]
                      : base.filter((c) => c !== kind.code);
                  })
                }
              />{" "}
              {kind.label}
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="accent-button"
          disabled={busy}
          onClick={() =>
            void run(
              async () => {
                await api.saveSettings({
                  inputOpener: opener,
                  dutyConflictAbsenceKinds: kinds,
                });
                await reloadDefinitions();
              },
              () => setNotice("学校設定を保存しました"),
            )
          }
        >
          学校設定を保存
        </button>
      </div>
    </Section>
  );
}

/** Item definitions and their legends (the options of a symbol /
 *  code item). Adding an item here is what makes it offerable as
 *  a view column below — DESIGN 5.2 scenario 7's path. */
function ItemsSection({ ctx }: { ctx: SectionCtx }) {
  const { defs, api, run, busy, deleteButton, setDefs } = ctx;
  const items = defs?.itemDefinitions ?? [];
  const groups = defs?.targetGroups ?? [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [valueType, setValueType] = useState("event_list");
  const [granularity, setGranularity] = useState("day");
  const [visibility, setVisibility] = useState("guardian");
  const [axis, setAxis] = useState("");
  const [sort, setSort] = useState("1");
  const [isActive, setIsActive] = useState(true);
  const [options, setOptions] = useState<Omit<ItemOptionData, "sort">[]>([]);

  const openForm = (itemDef: ItemDefinitionData | null) => {
    setEditingId(itemDef?.id ?? null);
    setName(itemDef?.name ?? "");
    setKey(itemDef?.key ?? "");
    setValueType(itemDef?.valueType ?? "event_list");
    setGranularity(itemDef?.granularity ?? "day");
    setVisibility(itemDef?.defaultVisibility ?? "guardian");
    setAxis(
      itemDef?.targetPlatformAxis
        ? `platform:${itemDef.targetPlatformAxis}`
        : itemDef?.targetGroupId
          ? `group:${itemDef.targetGroupId}`
          : "",
    );
    setSort(String(itemDef?.sort ?? items.length + 1));
    setIsActive(itemDef?.isActive !== false);
    setOptions(
      (itemDef?.options ?? []).map((o) => ({
        id: o.id,
        code: o.code,
        label: o.label,
        meaning: o.meaning ?? null,
      })),
    );
    setFormOpen(true);
  };

  const save = () =>
    run(
      async () => {
        const saved = await api.upsertItemDefinition({
          id: editingId ?? newRowId("item"),
          key,
          name,
          valueType,
          targetGroupId: axis.startsWith("group:") ? axis.slice("group:".length) : null,
          targetPlatformAxis: axis.startsWith("platform:") ? axis.slice("platform:".length) : null,
          granularity,
          defaultVisibility: visibility,
          isActive,
          sort: Number(sort) || 0,
          options: options.map((o, i) => ({
            id: o.id || newRowId("opt"),
            code: o.code,
            label: o.label,
            meaning: o.meaning || null,
            sort: i + 1,
          })),
        });
        setDefs((current) =>
          current
            ? {
                ...current,
                itemDefinitions: [
                  ...current.itemDefinitions.filter((i) => i.id !== saved.id),
                  saved,
                ].sort((a, b) => a.sort - b.sort),
              }
            : current,
        );
      },
      () => setFormOpen(false),
    );

  return (
    <Section title="項目定義と凡例">
      <ul className="settings-list">
        {items.map((itemDef) => (
          <li key={itemDef.id}>
            <span>
              {itemDef.name}
              <span className="dim">
                （{itemDef.key}／{VALUE_TYPE_LABELS[itemDef.valueType] ?? itemDef.valueType}／
                {GRANULARITY_LABELS[itemDef.granularity] ?? itemDef.granularity}／
                {VISIBILITY_LABELS[itemDef.defaultVisibility] ?? itemDef.defaultVisibility}
                {itemDef.options.length > 0 &&
                  `／凡例：${itemDef.options.map((o) => `${o.label}＝${o.meaning ?? o.code}`).join("、")}`}
                {itemDef.isActive === false && "／停止中"}）
              </span>
            </span>{" "}
            <button type="button" disabled={busy} onClick={() => openForm(itemDef)}>
              編集
            </button>{" "}
            {deleteButton(`item:${itemDef.id}`, "削除", async () => {
              await api.deleteItemDefinition({ id: itemDef.id });
              setDefs((current) =>
                current
                  ? {
                      ...current,
                      itemDefinitions: current.itemDefinitions.filter((i) => i.id !== itemDef.id),
                    }
                  : current,
              );
            })}
          </li>
        ))}
      </ul>
      {!formOpen && (
        <button type="button" disabled={busy} onClick={() => openForm(null)}>
          項目を追加
        </button>
      )}
      {formOpen && (
        <div className="settings-form">
          <label>
            名前{" "}
            <input aria-label="項目の名前" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            キー（英数字）{" "}
            <input aria-label="項目のキー" value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
          <label>
            値の型{" "}
            <select
              aria-label="値の型"
              value={valueType}
              onChange={(e) => setValueType(e.target.value)}
            >
              {Object.entries(VALUE_TYPE_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            粒度{" "}
            <select
              aria-label="粒度"
              value={granularity}
              onChange={(e) => setGranularity(e.target.value)}
            >
              {Object.entries(GRANULARITY_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            公開範囲{" "}
            <select
              aria-label="公開範囲"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
            >
              {Object.entries(VISIBILITY_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            対象軸{" "}
            <select aria-label="対象軸" value={axis} onChange={(e) => setAxis(e.target.value)}>
              <option value="">なし（全体）</option>
              <option value="platform:grade">学年（共通マスタ）</option>
              <option value="platform:class">クラス（共通マスタ）</option>
              <option value="platform:special_needs_class">特別支援学級（共通マスタ）</option>
              {groups.map((group) => (
                <option key={group.id} value={`group:${group.id}`}>
                  {group.name}（このアプリの対象軸）
                </option>
              ))}
            </select>
          </label>
          <label>
            並び順{" "}
            <input
              aria-label="項目の並び順"
              type="number"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />{" "}
            使用中
          </label>
          {(valueType === "symbol" || valueType === "code") && (
            <fieldset className="settings-checks">
              <legend>凡例（選べる値）</legend>
              {options.map((option, i) => (
                <div key={option.id || i} className="settings-row">
                  <input
                    aria-label="凡例のコード"
                    placeholder="コード"
                    value={option.code}
                    onChange={(e) =>
                      setOptions((list) =>
                        list.map((o, j) => (j === i ? { ...o, code: e.target.value } : o)),
                      )
                    }
                  />
                  <input
                    aria-label="凡例の表示"
                    placeholder="表示（○ など）"
                    value={option.label}
                    onChange={(e) =>
                      setOptions((list) =>
                        list.map((o, j) => (j === i ? { ...o, label: e.target.value } : o)),
                      )
                    }
                  />
                  <input
                    aria-label="凡例の意味"
                    placeholder="意味（出席 など）"
                    value={option.meaning ?? ""}
                    onChange={(e) =>
                      setOptions((list) =>
                        list.map((o, j) => (j === i ? { ...o, meaning: e.target.value } : o)),
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}
                  >
                    外す
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setOptions((list) => [...list, { id: "", code: "", label: "", meaning: null }])
                }
              >
                凡例を足す
              </button>
            </fieldset>
          )}
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() => void save()}
            >
              項目を保存
            </button>
            <button type="button" disabled={busy} onClick={() => setFormOpen(false)}>
              やめる
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

/** The app's own target axes and their targets (grades and
 *  clubs that are not the platform's masters live here). */
function TargetsSection({ ctx }: { ctx: SectionCtx }) {
  const { defs, api, run, busy, deleteButton, setDefs } = ctx;
  const groups = defs?.targetGroups ?? [];
  const [groupForm, setGroupForm] = useState<{
    id: string | null;
    name: string;
    key: string;
    sort: string;
  } | null>(null);
  const [targetForm, setTargetForm] = useState<{
    groupId: string;
    id: string | null;
    name: string;
    code: string;
    sort: string;
    parentTargetId: string;
  } | null>(null);

  const replaceGroup = (group: TargetGroupData) =>
    setDefs((current) =>
      current
        ? {
            ...current,
            targetGroups: [...current.targetGroups.filter((g) => g.id !== group.id), group].sort(
              (a, b) => a.sort - b.sort,
            ),
          }
        : current,
    );

  return (
    <Section title="対象軸と対象">
      {groups.map((group) => (
        <div key={group.id} className="settings-group">
          <p>
            <strong>{group.name}</strong>
            <span className="dim">（{group.key}）</span>{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setGroupForm({
                  id: group.id,
                  name: group.name,
                  key: group.key,
                  sort: String(group.sort),
                })
              }
            >
              軸を編集
            </button>{" "}
            {deleteButton(`group:${group.id}`, "軸を削除", async () => {
              await api.deleteTargetGroup({ id: group.id });
              setDefs((current) =>
                current
                  ? {
                      ...current,
                      targetGroups: current.targetGroups.filter((g) => g.id !== group.id),
                    }
                  : current,
              );
            })}
          </p>
          <ul className="settings-list">
            {group.targets.map((target) => (
              <li key={target.id}>
                <span>
                  {target.name}
                  {target.code && <span className="dim">（{target.code}）</span>}
                </span>{" "}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setTargetForm({
                      groupId: group.id,
                      id: target.id,
                      name: target.name,
                      code: target.code ?? "",
                      sort: String(target.sort),
                      parentTargetId: "",
                    })
                  }
                >
                  編集
                </button>{" "}
                {deleteButton(`target:${target.id}`, "削除", async () => {
                  await api.deleteTarget({ id: target.id });
                  setDefs((current) =>
                    current
                      ? {
                          ...current,
                          targetGroups: current.targetGroups.map((g) =>
                            g.id === group.id
                              ? { ...g, targets: g.targets.filter((t) => t.id !== target.id) }
                              : g,
                          ),
                        }
                      : current,
                  );
                })}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setTargetForm({
                groupId: group.id,
                id: null,
                name: "",
                code: "",
                sort: String(group.targets.length + 1),
                parentTargetId: "",
              })
            }
          >
            {group.name}に対象を追加
          </button>
        </div>
      ))}
      {groupForm === null && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            setGroupForm({ id: null, name: "", key: "", sort: String(groups.length + 1) })
          }
        >
          対象軸を追加
        </button>
      )}
      {groupForm && (
        <div className="settings-form">
          <label>
            軸の名前{" "}
            <input
              aria-label="軸の名前"
              value={groupForm.name}
              onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
            />
          </label>
          <label>
            軸のキー{" "}
            <input
              aria-label="軸のキー"
              value={groupForm.key}
              onChange={(e) => setGroupForm({ ...groupForm, key: e.target.value })}
            />
          </label>
          <label>
            並び順{" "}
            <input
              aria-label="軸の並び順"
              type="number"
              value={groupForm.sort}
              onChange={(e) => setGroupForm({ ...groupForm, sort: e.target.value })}
            />
          </label>
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const saved = (await api.upsertTargetGroup({
                      id: groupForm.id ?? newRowId("tg"),
                      key: groupForm.key,
                      name: groupForm.name,
                      sort: Number(groupForm.sort) || 0,
                    })) as TargetGroupData;
                    replaceGroup({
                      ...saved,
                      targets: groups.find((g) => g.id === saved.id)?.targets ?? [],
                    });
                  },
                  () => setGroupForm(null),
                )
              }
            >
              軸を保存
            </button>
            <button type="button" disabled={busy} onClick={() => setGroupForm(null)}>
              やめる
            </button>
          </div>
        </div>
      )}
      {targetForm && (
        <div className="settings-form">
          <label>
            対象の名前{" "}
            <input
              aria-label="対象の名前"
              value={targetForm.name}
              onChange={(e) => setTargetForm({ ...targetForm, name: e.target.value })}
            />
          </label>
          <label>
            コード{" "}
            <input
              aria-label="対象のコード"
              value={targetForm.code}
              onChange={(e) => setTargetForm({ ...targetForm, code: e.target.value })}
            />
          </label>
          <label>
            並び順{" "}
            <input
              aria-label="対象の並び順"
              type="number"
              value={targetForm.sort}
              onChange={(e) => setTargetForm({ ...targetForm, sort: e.target.value })}
            />
          </label>
          <label>
            上位の対象{" "}
            <select
              aria-label="上位の対象"
              value={targetForm.parentTargetId}
              onChange={(e) => setTargetForm({ ...targetForm, parentTargetId: e.target.value })}
            >
              <option value="">なし</option>
              {(groups.find((g) => g.id === targetForm.groupId)?.targets ?? [])
                .filter((t) => t.id !== targetForm.id)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const saved = (await api.upsertTarget({
                      id: targetForm.id ?? newRowId("tgt"),
                      targetGroupId: targetForm.groupId,
                      code: targetForm.code || null,
                      name: targetForm.name,
                      sort: Number(targetForm.sort) || 0,
                      parentTargetId: targetForm.parentTargetId || null,
                    })) as TargetData;
                    setDefs((current) =>
                      current
                        ? {
                            ...current,
                            targetGroups: current.targetGroups.map((g) =>
                              g.id === targetForm.groupId
                                ? {
                                    ...g,
                                    targets: [
                                      ...g.targets.filter((t) => t.id !== saved.id),
                                      saved,
                                    ].sort((a, b) => a.sort - b.sort),
                                  }
                                : g,
                            ),
                          }
                        : current,
                    );
                  },
                  () => setTargetForm(null),
                )
              }
            >
              対象を保存
            </button>
            <button type="button" disabled={busy} onClick={() => setTargetForm(null)}>
              やめる
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

/** Locations: this app's own master (DESIGN schedule 4.5.1). */
function LocationsSection({ ctx }: { ctx: SectionCtx }) {
  const { defs, api, run, busy, deleteButton, setDefs } = ctx;
  const locations = defs?.locations ?? [];
  const [form, setForm] = useState<{
    id: string | null;
    name: string;
    kind: string;
    sort: string;
    isActive: boolean;
  } | null>(null);

  return (
    <Section title="場所">
      <ul className="settings-list">
        {locations.map((location) => (
          <li key={location.id}>
            <span>
              {location.name}
              {location.kind && <span className="dim">（{location.kind}）</span>}
              {location.isActive === false && <span className="dim">（停止中）</span>}
            </span>{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setForm({
                  id: location.id,
                  name: location.name,
                  kind: location.kind ?? "",
                  sort: String(location.sort),
                  isActive: location.isActive !== false,
                })
              }
            >
              編集
            </button>{" "}
            {deleteButton(`location:${location.id}`, "削除", async () => {
              await api.deleteLocation({ id: location.id });
              setDefs((current) =>
                current
                  ? { ...current, locations: current.locations.filter((l) => l.id !== location.id) }
                  : current,
              );
            })}
          </li>
        ))}
      </ul>
      {form === null && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            setForm({
              id: null,
              name: "",
              kind: "",
              sort: String(locations.length + 1),
              isActive: true,
            })
          }
        >
          場所を追加
        </button>
      )}
      {form && (
        <div className="settings-form">
          <label>
            場所の名前{" "}
            <input
              aria-label="場所の名前"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            種別{" "}
            <input
              aria-label="場所の種別"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            />
          </label>
          <label>
            並び順{" "}
            <input
              aria-label="場所の並び順"
              type="number"
              value={form.sort}
              onChange={(e) => setForm({ ...form, sort: e.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />{" "}
            使用中
          </label>
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const saved: LocationData = await api.upsertLocation({
                      id: form.id ?? newRowId("loc"),
                      name: form.name,
                      kind: form.kind || null,
                      sort: Number(form.sort) || 0,
                      isActive: form.isActive,
                    });
                    setDefs((current) =>
                      current
                        ? {
                            ...current,
                            locations: [
                              ...current.locations.filter((l) => l.id !== saved.id),
                              saved,
                            ].sort((a, b) => a.sort - b.sort),
                          }
                        : current,
                    );
                  },
                  () => setForm(null),
                )
              }
            >
              場所を保存
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

/** Duty definitions and their rotation rosters. The roster's
 *  order is the rotation's order; the panel edits it directly
 *  (the candidates of the duty panel are ranked from it). */
function DutiesSection({ ctx }: { ctx: SectionCtx }) {
  const { duties, setDuties, api, run, busy, deleteButton, bootstrap, defs } = ctx;
  const staff = bootstrap.masters.staff;
  const [form, setForm] = useState<{
    id: string | null;
    name: string;
    granularity: string;
    applicablePeriod: string;
    startsOn: string;
    endsOn: string;
    targetGroupId: string;
    sort: string;
    useRotation: boolean;
    roster: string[];
    useWeekdays: boolean;
    weekdays: string[];
  } | null>(null);

  const openForm = (duty: DutyDefinitionData | null) => {
    setForm({
      id: duty?.id ?? null,
      name: duty?.name ?? "",
      granularity: duty?.granularity ?? "day",
      applicablePeriod: duty?.applicablePeriod ?? "all_year",
      startsOn: duty?.applicableStartsOn ?? "",
      endsOn: duty?.applicableEndsOn ?? "",
      targetGroupId: duty?.targetGroupId ?? "",
      sort: String(duty?.sort ?? duties.length + 1),
      useRotation: duty ? duty.rotation !== null : true,
      roster: duty?.rotation?.personIds ?? [],
      useWeekdays: duty?.rotation?.changeWeekdays != null,
      weekdays: duty?.rotation?.changeWeekdays ?? ["mon"],
    });
  };

  return (
    <Section title="当番定義と輪番">
      <ul className="settings-list">
        {duties.map((duty) => (
          <li key={duty.id}>
            <span>
              {duty.name}
              <span className="dim">
                （{GRANULARITY_LABELS[duty.granularity] ?? duty.granularity}／
                {DUTY_PERIOD_LABELS[duty.applicablePeriod] ?? duty.applicablePeriod}
                {duty.rotation
                  ? `／輪番：${duty.rotation.personIds.map((id) => staff.find((s) => s.id === id)?.name ?? id).join(" → ")}`
                  : "／輪番なし"}
                ）
              </span>
            </span>{" "}
            <button type="button" disabled={busy} onClick={() => openForm(duty)}>
              編集
            </button>{" "}
            {deleteButton(`duty:${duty.id}`, "削除", async () => {
              await api.deleteDutyDefinition({ id: duty.id });
              setDuties((list) => list.filter((d) => d.id !== duty.id));
            })}
          </li>
        ))}
      </ul>
      {form === null && (
        <button type="button" disabled={busy} onClick={() => openForm(null)}>
          当番を追加
        </button>
      )}
      {form && (
        <div className="settings-form">
          <label>
            当番の名前{" "}
            <input
              aria-label="当番の名前"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            粒度{" "}
            <select
              aria-label="当番の粒度"
              value={form.granularity}
              onChange={(e) => setForm({ ...form, granularity: e.target.value })}
            >
              <option value="day">日ごと</option>
              <option value="am_pm">午前・午後</option>
              <option value="week">週ごと</option>
              <option value="period">時限ごと</option>
            </select>
          </label>
          <label>
            適用期間{" "}
            <select
              aria-label="適用期間"
              value={form.applicablePeriod}
              onChange={(e) => setForm({ ...form, applicablePeriod: e.target.value })}
            >
              {Object.entries(DUTY_PERIOD_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {form.applicablePeriod === "custom_range" && (
            <>
              <label>
                開始日{" "}
                <input
                  aria-label="適用開始日"
                  type="date"
                  value={form.startsOn}
                  onChange={(e) => setForm({ ...form, startsOn: e.target.value })}
                />
              </label>
              <label>
                終了日{" "}
                <input
                  aria-label="適用終了日"
                  type="date"
                  value={form.endsOn}
                  onChange={(e) => setForm({ ...form, endsOn: e.target.value })}
                />
              </label>
            </>
          )}
          <label>
            対象軸（生徒の当番のとき）{" "}
            <select
              aria-label="当番の対象軸"
              value={form.targetGroupId}
              onChange={(e) => setForm({ ...form, targetGroupId: e.target.value })}
            >
              <option value="">なし（教職員）</option>
              {(defs?.targetGroups ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.useRotation}
              onChange={(e) => setForm({ ...form, useRotation: e.target.checked })}
            />{" "}
            輪番で自動的に割り当てる
          </label>
          {form.useRotation && (
            <>
              <fieldset className="settings-checks">
                <legend>輪番の顔ぶれ（この順に回ります）</legend>
                {form.roster.map((personId, i) => (
                  <div key={personId} className="settings-row">
                    <span>
                      {i + 1}. {staff.find((s) => s.id === personId)?.name ?? personId}
                    </span>
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() =>
                        setForm({
                          ...form,
                          roster: form.roster.map((p, j) =>
                            j === i - 1 ? personId : j === i ? (form.roster[i - 1] as string) : p,
                          ),
                        })
                      }
                    >
                      上へ
                    </button>
                    <button
                      type="button"
                      disabled={i === form.roster.length - 1}
                      onClick={() =>
                        setForm({
                          ...form,
                          roster: form.roster.map((p, j) =>
                            j === i + 1 ? personId : j === i ? (form.roster[i + 1] as string) : p,
                          ),
                        })
                      }
                    >
                      下へ
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setForm({ ...form, roster: form.roster.filter((p) => p !== personId) })
                      }
                    >
                      外す
                    </button>
                  </div>
                ))}
                {staff
                  .filter((s) => !form.roster.includes(s.id))
                  .map((s) => (
                    <div key={s.id} className="settings-row">
                      <span className="dim">{s.name}</span>
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, roster: [...form.roster, s.id] })}
                      >
                        輪番に足す
                      </button>
                    </div>
                  ))}
              </fieldset>
              <label>
                <input
                  type="checkbox"
                  checked={form.useWeekdays}
                  onChange={(e) => setForm({ ...form, useWeekdays: e.target.checked })}
                />{" "}
                交代する曜日を決める（決めない場合はマスごとに進みます）
              </label>
              {form.useWeekdays && (
                <fieldset className="settings-checks">
                  <legend>交代曜日</legend>
                  {WEEKDAYS.map((day) => (
                    <label key={day.code}>
                      <input
                        type="checkbox"
                        checked={form.weekdays.includes(day.code)}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            weekdays: e.target.checked
                              ? [...form.weekdays, day.code]
                              : form.weekdays.filter((d) => d !== day.code),
                          })
                        }
                      />{" "}
                      {day.label}
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          )}
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const saved = await api.upsertDutyDefinition({
                      id: form.id ?? newRowId("duty"),
                      name: form.name,
                      granularity: form.granularity,
                      applicablePeriod: form.applicablePeriod,
                      applicableStartsOn:
                        form.applicablePeriod === "custom_range" ? form.startsOn || null : null,
                      applicableEndsOn:
                        form.applicablePeriod === "custom_range" ? form.endsOn || null : null,
                      targetGroupId: form.targetGroupId || null,
                      sort: Number(form.sort) || 0,
                      rotation: form.useRotation
                        ? {
                            personIds: form.roster,
                            changeWeekdays: form.useWeekdays ? form.weekdays : null,
                          }
                        : null,
                    });
                    setDuties((list) =>
                      [...list.filter((d) => d.id !== saved.id), saved].sort(
                        (a, b) => a.sort - b.sort,
                      ),
                    );
                  },
                  () => setForm(null),
                )
              }
            >
              当番を保存
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

/** Views: their columns (add / remove / reorder), audience,
 *  layout, and a header preview of the columns as the table
 *  will head them. */
function ViewsSection({ ctx }: { ctx: SectionCtx }) {
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

  return (
    <Section title="ビュー（表示の定義）">
      <ul className="settings-list">
        {views.map((view) => (
          <li key={view.id}>
            <span>
              {view.name}
              <span className="dim">
                （{LAYOUT_LABELS[view.layout] ?? view.layout}／
                {AUDIENCE_LABELS[view.audience] ?? view.audience}／
                {PERIOD_SCOPE_LABELS[view.periodScope] ?? view.periodScope}／列{view.columns.length}
                件）
              </span>
            </span>{" "}
            <button type="button" disabled={busy} onClick={() => openForm(view)}>
              編集
            </button>{" "}
            {deleteButton(`view:${view.id}`, "削除", async () => {
              await api.deleteViewDefinition({ id: view.id });
              setViews((list) => list.filter((v) => v.id !== view.id));
            })}
          </li>
        ))}
      </ul>
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

/** Kind templates: the shape of one kind of entry (Issue #29) —
 *  which platform record it saves as, and the steps the quick
 *  input walks through (Issue #36). */
function TemplatesSection({ ctx }: { ctx: SectionCtx }) {
  const { templates, setTemplates, api, run, busy, deleteButton, defs, setNotice } = ctx;
  const items = defs?.itemDefinitions ?? [];
  const [form, setForm] = useState<{
    id: string | null;
    key: string;
    name: string;
    subjectKind: "event" | "absence";
    kindCode: string;
    personLabel: string;
    displaySource: string;
    sort: string;
    steps: { kind: string; itemDefinitionId: string | null }[];
    itemDefinitionIds: string[];
  } | null>(null);

  const openForm = (template: KindTemplateData | null) => {
    setForm({
      id: template?.id ?? null,
      key: template?.key ?? "",
      name: template?.name ?? "",
      subjectKind: template?.subjectKind ?? "event",
      kindCode: template?.kindCode ?? "event",
      personLabel: template?.personLabel ?? "担当者",
      displaySource: template?.displaySource ?? "title",
      sort: String(template?.sort ?? templates.length + 1),
      steps: template
        ? template.steps.map((s) => ({
            kind: s.kind,
            itemDefinitionId: s.itemDefinitionId ?? null,
          }))
        : [{ kind: "person", itemDefinitionId: null }],
      itemDefinitionIds: template?.itemDefinitionIds ?? [],
    });
  };

  return (
    <Section title="種別テンプレート">
      <ul className="settings-list">
        {templates.map((template) => (
          <li key={template.id}>
            <span>
              {template.name}
              <span className="dim">
                （{template.key}／{template.subjectKind === "absence" ? "不在" : "行事"}／
                {template.steps.map((s) => STEP_KIND_LABELS[s.kind] ?? s.kind).join("→")}）
              </span>
            </span>{" "}
            <button type="button" disabled={busy} onClick={() => openForm(template)}>
              編集
            </button>{" "}
            {deleteButton(`template:${template.id}`, "削除", async () => {
              await api.deleteKindTemplate({ id: template.id });
              setTemplates((list) => list.filter((t) => t.id !== template.id));
            })}
          </li>
        ))}
      </ul>
      <div className="settings-row">
        {form === null && (
          <button type="button" disabled={busy} onClick={() => openForm(null)}>
            テンプレートを追加
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(
              async () => {
                const applied = (await api.applyDefaultKindTemplates()) as KindTemplateData[];
                if (Array.isArray(applied)) setTemplates(applied);
              },
              () => setNotice("既定の種別テンプレートを適用しました"),
            )
          }
        >
          既定のテンプレートを適用
        </button>
      </div>
      {form && (
        <div className="settings-form">
          <label>
            名前{" "}
            <input
              aria-label="テンプレートの名前"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            キー{" "}
            <input
              aria-label="テンプレートのキー"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
          </label>
          <label>
            保存先{" "}
            <select
              aria-label="保存先"
              value={form.subjectKind}
              onChange={(e) =>
                setForm({
                  ...form,
                  subjectKind: e.target.value as "event" | "absence",
                  kindCode: e.target.value === "absence" ? "business_trip" : "event",
                })
              }
            >
              <option value="event">行事</option>
              <option value="absence">不在（出張・休暇）</option>
            </select>
          </label>
          <label>
            種別コード{" "}
            <select
              aria-label="種別コード"
              value={form.kindCode}
              onChange={(e) => setForm({ ...form, kindCode: e.target.value })}
            >
              {(form.subjectKind === "absence"
                ? [
                    ["business_trip", "出張"],
                    ["training", "研修"],
                    ["leave", "休暇"],
                    ["other", "その他"],
                  ]
                : [
                    ["event", "行事"],
                    ["meeting", "会議"],
                    ["exam", "考査"],
                    ["deadline", "〆切"],
                    ["other", "その他"],
                  ]
              ).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            人の呼び名{" "}
            <input
              aria-label="人の呼び名"
              value={form.personLabel}
              onChange={(e) => setForm({ ...form, personLabel: e.target.value })}
            />
          </label>
          <label>
            セルの表示{" "}
            <select
              aria-label="セルの表示"
              value={form.displaySource}
              onChange={(e) => setForm({ ...form, displaySource: e.target.value })}
            >
              <option value="title">件名で表示</option>
              <option value="person">人で表示</option>
              <option value="person_title">人と件名で表示</option>
            </select>
          </label>
          <fieldset className="settings-checks">
            <legend>ステップ（クイック入力の順）</legend>
            {form.steps.map((step, i) => (
              <div key={i} className="settings-row">
                <select
                  aria-label="ステップの種類"
                  value={step.kind}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      steps: form.steps.map((s, j) =>
                        j === i ? { ...s, kind: e.target.value } : s,
                      ),
                    })
                  }
                >
                  {Object.entries(STEP_KIND_LABELS).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
                {step.kind === "item" && (
                  <select
                    aria-label="ステップの項目"
                    value={step.itemDefinitionId ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        steps: form.steps.map((s, j) =>
                          j === i ? { ...s, itemDefinitionId: e.target.value || null } : s,
                        ),
                      })
                    }
                  >
                    <option value="">項目を選ぶ</option>
                    {items.map((itemDef) => (
                      <option key={itemDef.id} value={itemDef.id}>
                        {itemDef.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={() => setForm({ ...form, steps: form.steps.filter((_, j) => j !== i) })}
                >
                  外す
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setForm({
                  ...form,
                  steps: [...form.steps, { kind: "time", itemDefinitionId: null }],
                })
              }
            >
              ステップを足す
            </button>
          </fieldset>
          <fieldset className="settings-checks">
            <legend>追加項目（詳細で付ける項目）</legend>
            {items.map((itemDef) => (
              <label key={itemDef.id}>
                <input
                  type="checkbox"
                  checked={form.itemDefinitionIds.includes(itemDef.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      itemDefinitionIds: e.target.checked
                        ? [...form.itemDefinitionIds, itemDef.id]
                        : form.itemDefinitionIds.filter((id) => id !== itemDef.id),
                    })
                  }
                />{" "}
                {itemDef.name}
              </label>
            ))}
          </fieldset>
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const saved = await api.upsertKindTemplate({
                      id: form.id ?? newRowId("tpl"),
                      key: form.key,
                      name: form.name,
                      subjectKind: form.subjectKind,
                      kindCode: form.kindCode,
                      personLabel: form.personLabel,
                      displaySource: form.displaySource,
                      steps: form.steps,
                      itemDefinitionIds: form.itemDefinitionIds,
                      sort: Number(form.sort) || 0,
                    });
                    setTemplates((list) =>
                      [...list.filter((t) => t.id !== saved.id), saved].sort(
                        (a, b) => a.sort - b.sort,
                      ),
                    );
                  },
                  () => setForm(null),
                )
              }
            >
              テンプレートを保存
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

const MASTER_KIND_LABELS: Record<MasterKindData, string> = {
  staff: "教職員",
  grade: "学年",
  class: "クラス",
  special_needs_class: "特別支援学級",
  day_pattern: "日課・時限",
};
const DAY_PATTERN_KIND_LABELS: Record<string, string> = {
  normal: "通常",
  shortened: "短縮",
  exam: "考査",
  special: "特別",
};

function masterText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}
function masterNum(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

interface PeriodDraft {
  period: string;
  label: string;
  startsAt: string;
  endsAt: string;
}

/** The shared masters, edited through the relay: the platform
 *  owns them (staff, grades, classes, special-needs classes,
 *  day patterns with their periods) and judges every write. */
function MastersSection({ ctx }: { ctx: SectionCtx }) {
  const { masters, setMasters, api, run, busy, deleteButton } = ctx;
  const [kind, setKind] = useState<MasterKindData>("staff");
  const [form, setForm] = useState<{
    id: string | null;
    revision: number;
    fields: Record<string, string | boolean>;
    periods: PeriodDraft[];
  } | null>(null);

  const records: Record<string, unknown>[] = masters
    ? (masters[kind] as Record<string, unknown>[])
    : [];
  const grades = masters?.grade ?? [];

  const replaceRecord = (record: Record<string, unknown>) =>
    setMasters((current) =>
      current
        ? {
            ...current,
            [kind]: [
              ...(current[kind] as Record<string, unknown>[]).filter(
                (r) => r["id"] !== record["id"],
              ),
              record,
            ].sort((a, b) => masterNum(a, "sortOrder") - masterNum(b, "sortOrder")),
          }
        : current,
    );

  const openForm = (record: Record<string, unknown> | null) => {
    const fields: Record<string, string | boolean> = {};
    if (kind === "staff") {
      fields.name = record ? masterText(record, "name") : "";
      fields.shortName = record ? masterText(record, "shortName") : "";
      fields.sortOrder = String(record ? masterNum(record, "sortOrder") : records.length + 1);
      fields.active = record ? record["active"] !== false : true;
      fields.personId = record ? masterText(record, "personId") : "";
    } else if (kind === "grade") {
      fields.name = record ? masterText(record, "name") : "";
      fields.sortOrder = String(record ? masterNum(record, "sortOrder") : records.length + 1);
      fields.stage = record ? masterText(record, "stage") : "";
    } else if (kind === "class") {
      fields.name = record ? masterText(record, "name") : "";
      fields.gradeId = record
        ? masterText(record, "gradeId")
        : ((grades[0]?.["id"] as string) ?? "");
      fields.sortOrder = String(record ? masterNum(record, "sortOrder") : records.length + 1);
    } else if (kind === "special_needs_class") {
      fields.name = record ? masterText(record, "name") : "";
      fields.sortOrder = String(record ? masterNum(record, "sortOrder") : records.length + 1);
    } else {
      fields.code = record ? masterText(record, "code") : "";
      fields.name = record ? masterText(record, "name") : "";
      fields.kind = record ? masterText(record, "kind") || "normal" : "normal";
    }
    const periods: PeriodDraft[] =
      kind === "day_pattern"
        ? (
            (record?.["periods"] as
              | { period: number; label: string; startsAt: string; endsAt: string }[]
              | undefined) ?? [{ period: 1, label: "1限", startsAt: "08:45", endsAt: "09:35" }]
          ).map((p) => ({
            period: String(p.period),
            label: p.label,
            startsAt: p.startsAt,
            endsAt: p.endsAt,
          }))
        : [];
    setForm({
      id: record ? String(record["id"]) : null,
      revision: record ? masterNum(record, "revision") || 1 : 1,
      fields,
      periods,
    });
  };

  const buildRecord = (): Record<string, unknown> => {
    const f = form?.fields ?? {};
    const base: Record<string, unknown> = { id: form?.id ?? newRowId("m") };
    if (kind === "staff") {
      base.name = f.name;
      base.shortName = f.shortName || f.name;
      base.sortOrder = Number(f.sortOrder) || 0;
      base.active = f.active === true;
      base.personId = f.personId ? String(f.personId) : null;
    } else if (kind === "grade") {
      base.name = f.name;
      base.sortOrder = Number(f.sortOrder) || 0;
      base.stage = f.stage ? String(f.stage) : null;
    } else if (kind === "class") {
      base.gradeId = f.gradeId;
      base.name = f.name;
      base.sortOrder = Number(f.sortOrder) || 0;
    } else if (kind === "special_needs_class") {
      base.name = f.name;
      base.sortOrder = Number(f.sortOrder) || 0;
    } else {
      base.code = f.code;
      base.name = f.name;
      base.kind = f.kind;
      base.periods = (form?.periods ?? []).map((p) => ({
        period: Number(p.period) || 0,
        label: p.label,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
      }));
    }
    return base;
  };

  const setField = (key: string, value: string | boolean) =>
    setForm((current) =>
      current ? { ...current, fields: { ...current.fields, [key]: value } } : current,
    );

  const recordLabel = (record: Record<string, unknown>): string => {
    if (kind === "day_pattern") {
      const periods = Array.isArray(record["periods"]) ? record["periods"].length : 0;
      return `${masterText(record, "code")} ${masterText(record, "name")}（${DAY_PATTERN_KIND_LABELS[masterText(record, "kind")] ?? ""}／${periods}時限）`;
    }
    if (kind === "staff") {
      return `${masterText(record, "name")}${record["active"] === false ? "（停止中）" : ""}`;
    }
    if (kind === "class") {
      const grade = grades.find((g) => g["id"] === record["gradeId"]);
      return `${grade ? masterText(grade as Record<string, unknown>, "name") : ""} ${masterText(record, "name")}`;
    }
    return masterText(record, "name");
  };

  return (
    <Section title="共通マスタ（基盤と共有）">
      <p className="dim">
        教職員・学年・クラス・特別支援学級・日課は共通基盤のマスタです。ここでの変更は基盤側で判定され、ほかのアプリにも届きます。
      </p>
      <div className="settings-row" role="tablist" aria-label="マスタの種類">
        {(Object.keys(MASTER_KIND_LABELS) as MasterKindData[]).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            className={kind === k ? "accent-button" : undefined}
            onClick={() => {
              setKind(k);
              setForm(null);
            }}
          >
            {MASTER_KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <ul className="settings-list">
        {records.map((record) => (
          <li key={String(record["id"])}>
            <span>{recordLabel(record)}</span>{" "}
            <button type="button" disabled={busy} onClick={() => openForm(record)}>
              編集
            </button>{" "}
            {deleteButton(`master:${kind}:${String(record["id"])}`, "削除", async () => {
              await api.deleteMaster({
                kind,
                id: String(record["id"]),
                revision: masterNum(record, "revision") || 1,
              });
              setMasters((current) =>
                current
                  ? {
                      ...current,
                      [kind]: (current[kind] as Record<string, unknown>[]).filter(
                        (r) => r["id"] !== record["id"],
                      ),
                    }
                  : current,
              );
            })}
          </li>
        ))}
      </ul>
      {form === null && (
        <button type="button" disabled={busy} onClick={() => openForm(null)}>
          {MASTER_KIND_LABELS[kind]}を追加
        </button>
      )}
      {form && (
        <div className="settings-form">
          {kind === "day_pattern" && (
            <label>
              コード{" "}
              <input
                aria-label="日課のコード"
                value={String(form.fields.code ?? "")}
                onChange={(e) => setField("code", e.target.value)}
              />
            </label>
          )}
          <label>
            名前{" "}
            <input
              aria-label="マスタの名前"
              value={String(form.fields.name ?? "")}
              onChange={(e) => setField("name", e.target.value)}
            />
          </label>
          {kind === "staff" && (
            <>
              <label>
                略称{" "}
                <input
                  aria-label="略称"
                  value={String(form.fields.shortName ?? "")}
                  onChange={(e) => setField("shortName", e.target.value)}
                />
              </label>
              <label>
                ログイン利用者のID（任意）{" "}
                <input
                  aria-label="ログイン利用者のID"
                  value={String(form.fields.personId ?? "")}
                  onChange={(e) => setField("personId", e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.fields.active === true}
                  onChange={(e) => setField("active", e.target.checked)}
                />{" "}
                在籍中
              </label>
            </>
          )}
          {kind === "grade" && (
            <label>
              課程（任意）{" "}
              <input
                aria-label="課程"
                value={String(form.fields.stage ?? "")}
                onChange={(e) => setField("stage", e.target.value)}
              />
            </label>
          )}
          {kind === "class" && (
            <label>
              学年{" "}
              <select
                aria-label="クラスが属する学年"
                value={String(form.fields.gradeId ?? "")}
                onChange={(e) => setField("gradeId", e.target.value)}
              >
                {grades.map((grade) => (
                  <option key={String(grade["id"])} value={String(grade["id"])}>
                    {masterText(grade as Record<string, unknown>, "name")}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === "day_pattern" && (
            <>
              <label>
                種別{" "}
                <select
                  aria-label="日課の種別"
                  value={String(form.fields.kind ?? "normal")}
                  onChange={(e) => setField("kind", e.target.value)}
                >
                  {Object.entries(DAY_PATTERN_KIND_LABELS).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="settings-checks">
                <legend>時限と時刻</legend>
                {form.periods.map((period, i) => (
                  <div key={i} className="settings-row">
                    <input
                      aria-label="時限番号"
                      type="number"
                      value={period.period}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          periods: form.periods.map((p, j) =>
                            j === i ? { ...p, period: e.target.value } : p,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label="時限の表示"
                      value={period.label}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          periods: form.periods.map((p, j) =>
                            j === i ? { ...p, label: e.target.value } : p,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label="開始時刻"
                      type="time"
                      value={period.startsAt}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          periods: form.periods.map((p, j) =>
                            j === i ? { ...p, startsAt: e.target.value } : p,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label="終了時刻"
                      type="time"
                      value={period.endsAt}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          periods: form.periods.map((p, j) =>
                            j === i ? { ...p, endsAt: e.target.value } : p,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setForm({ ...form, periods: form.periods.filter((_, j) => j !== i) })
                      }
                    >
                      外す
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      periods: [
                        ...form.periods,
                        {
                          period: String(form.periods.length + 1),
                          label: `${form.periods.length + 1}限`,
                          startsAt: "13:30",
                          endsAt: "14:20",
                        },
                      ],
                    })
                  }
                >
                  時限を足す
                </button>
              </fieldset>
            </>
          )}
          {kind !== "day_pattern" && (
            <label>
              並び順{" "}
              <input
                aria-label="マスタの並び順"
                type="number"
                value={String(form.fields.sortOrder ?? "")}
                onChange={(e) => setField("sortOrder", e.target.value)}
              />
            </label>
          )}
          <div className="settings-row">
            <button
              type="button"
              className="accent-button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const record = buildRecord();
                    const saved =
                      form.id === null
                        ? await api.createMaster({ kind, record })
                        : await api.updateMaster({
                            kind,
                            id: form.id,
                            record: { ...record, revision: form.revision },
                          });
                    replaceRecord(saved);
                  },
                  () => setForm(null),
                )
              }
            >
              {MASTER_KIND_LABELS[kind]}を保存
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
