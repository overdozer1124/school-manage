import { useState } from "react";
import type { ItemDefinitionData, ItemOptionData } from "../types";
import {
  GRANULARITY_LABELS,
  VALUE_TYPE_LABELS,
  VISIBILITY_LABELS,
  newRowId,
  Section,
  type SectionCtx,
} from "./shared";

/** Item definitions and their legends (the options of a symbol /
 *  code item). Adding an item here is what makes it offerable as
 *  a view column below — DESIGN 5.2 scenario 7's path. */
export function ItemsSection({ ctx }: { ctx: SectionCtx }) {
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
