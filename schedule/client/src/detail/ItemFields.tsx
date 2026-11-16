import { isValidTimeString, timeToMinutes } from "@school-manage/calendar-types";
import type { BootstrapData, EventValueData, ItemDefinitionData, KindTemplateData } from "../types";

/**
 * The detail modal's additional items (event_values, Issue #37):
 * which item definitions a template binds, how a stored row
 * becomes an editable draft and back, and the fields themselves.
 * The drafts live in the modal, which rewrites the whole set on
 * save; this file owns their shape and their rendering.
 */

export interface ItemDraft {
  text: string;
  end: string;
}

export function draftOfRow(row: EventValueData, itemDef: ItemDefinitionData): ItemDraft {
  switch (itemDef.valueType) {
    case "symbol":
    case "code":
      return {
        text: itemDef.options.find((o) => o.id === row.valueOptionId)?.code ?? "",
        end: "",
      };
    case "time":
      return { text: row.valueTime ?? "", end: "" };
    case "time_range":
      return { text: row.valueTime ?? "", end: row.valueTimeEnd ?? "" };
    case "number":
      return { text: row.valueNumber !== null ? String(row.valueNumber) : "", end: "" };
    case "boolean":
      return { text: row.valueBoolean === null ? "" : String(row.valueBoolean), end: "" };
    case "person":
      return { text: row.valuePersonId ?? "", end: "" };
    default:
      return { text: row.valueText ?? "", end: "" };
  }
}

/** The value a draft sends, or undefined when the draft is not a
 *  value the item can hold (the caller names the item and stops). */
export function draftValueOf(itemDef: ItemDefinitionData, draft: ItemDraft): unknown {
  const text = draft.text.trim();
  switch (itemDef.valueType) {
    case "text":
      return text === "" ? null : text;
    case "symbol":
    case "code":
    case "person":
      return text === "" ? null : text;
    case "time":
      return text === "" ? null : isValidTimeString(text) ? text : undefined;
    case "time_range": {
      const end = draft.end.trim();
      if (text === "" && end === "") return null;
      if (!isValidTimeString(text) || !isValidTimeString(end)) return undefined;
      if (timeToMinutes(end) <= timeToMinutes(text)) return undefined;
      return { startsAt: text, endsAt: end };
    }
    case "number": {
      if (text === "") return null;
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case "boolean":
      return text === "" ? null : text === "true";
    default:
      return text === "" ? null : text;
  }
}

/** The item definitions a template binds as its additional items:
 *  its 追加項目 (itemDefinitionIds) first, then any item step's
 *  binding not already among them. Types this form cannot edit
 *  (persons lists, per-target time maps) are left out of the form;
 *  their stored rows are still carried through a save untouched. */
const EDITABLE_VALUE_TYPES = [
  "text",
  "symbol",
  "code",
  "time",
  "time_range",
  "number",
  "boolean",
  "person",
];

export function itemDefsOf(
  template: KindTemplateData,
  bootstrap: BootstrapData,
): ItemDefinitionData[] {
  const ids: string[] = [];
  for (const id of template.itemDefinitionIds ?? []) if (!ids.includes(id)) ids.push(id);
  for (const step of template.steps) {
    if (step.kind === "item" && step.itemDefinitionId && !ids.includes(step.itemDefinitionId)) {
      ids.push(step.itemDefinitionId);
    }
  }
  return ids
    .map((id) => bootstrap.itemDefinitions.find((i) => i.id === id))
    .filter(
      (d): d is ItemDefinitionData => d !== undefined && EDITABLE_VALUE_TYPES.includes(d.valueType),
    );
}

export function ItemFields({
  defs,
  drafts,
  onDraftChange,
  valuesLoaded,
  valuesFailed,
  bootstrap,
}: {
  defs: ItemDefinitionData[];
  drafts: Record<string, ItemDraft>;
  onDraftChange(defId: string, draft: ItemDraft): void;
  /** The stored rows have been read; until then the fields are
   *  disabled, so a save cannot rewrite a set not yet seen. */
  valuesLoaded: boolean;
  valuesFailed: boolean;
  bootstrap: BootstrapData;
}) {
  if (defs.length === 0) return null;
  return (
    <>
      {defs.map((def) => {
        const draft = drafts[def.id] ?? { text: "", end: "" };
        const setDraft = (next: ItemDraft) => onDraftChange(def.id, next);
        return (
          <div key={def.id}>
            <label className="detail-label" htmlFor={`detail-item-${def.id}`}>
              {def.name}
            </label>
            {def.valueType === "symbol" || def.valueType === "code" ? (
              <select
                id={`detail-item-${def.id}`}
                aria-label={def.name}
                value={draft.text}
                disabled={!valuesLoaded}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              >
                <option value="">（なし）</option>
                {def.options.map((o) => (
                  <option key={o.id} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : def.valueType === "boolean" ? (
              <select
                id={`detail-item-${def.id}`}
                aria-label={def.name}
                value={draft.text}
                disabled={!valuesLoaded}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              >
                <option value="">（なし）</option>
                <option value="true">○</option>
                <option value="false">×</option>
              </select>
            ) : def.valueType === "person" ? (
              <select
                id={`detail-item-${def.id}`}
                aria-label={def.name}
                value={draft.text}
                disabled={!valuesLoaded}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              >
                <option value="">（なし）</option>
                {bootstrap.masters.staff
                  .filter((s) => typeof s.name === "string")
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            ) : def.valueType === "time_range" ? (
              <span className="time-range-editor">
                <input
                  id={`detail-item-${def.id}`}
                  aria-label={`${def.name} 開始`}
                  value={draft.text}
                  placeholder="HH:MM"
                  disabled={!valuesLoaded}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                />
                <span>〜</span>
                <input
                  aria-label={`${def.name} 終了`}
                  value={draft.end}
                  placeholder="HH:MM"
                  disabled={!valuesLoaded}
                  onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                />
              </span>
            ) : (
              <input
                id={`detail-item-${def.id}`}
                aria-label={def.name}
                value={draft.text}
                inputMode={def.valueType === "number" ? "decimal" : undefined}
                placeholder={def.valueType === "time" ? "HH:MM" : undefined}
                disabled={!valuesLoaded}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              />
            )}
          </div>
        );
      })}
      {valuesFailed && (
        <p className="cell-notice" role="alert">
          追加項目を読み込めませんでした。追加項目は保存されません
        </p>
      )}
    </>
  );
}
