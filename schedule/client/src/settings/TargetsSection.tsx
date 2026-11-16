import { useState } from "react";
import type { TargetData, TargetGroupData } from "../types";
import { newRowId, Section, type SectionCtx } from "./shared";

/** The app's own target axes and their targets (grades and
 *  clubs that are not the platform's masters live here). */
export function TargetsSection({ ctx }: { ctx: SectionCtx }) {
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
