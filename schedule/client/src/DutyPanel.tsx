import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, ForbiddenError, type ScheduleApi } from "./api";
import { absenceKindLabel, dayLabel, slotLabel, staffName } from "./lib";
import type {
  BootstrapData,
  DutyChangeData,
  DutyConflictData,
  RangeData,
  RotationPlanCellData,
} from "./types";

/**
 * The duty panel (Issue #38), ported from the prototype's
 * client/src/DutyPanel.tsx (school-schedule, frozen) and rebuilt
 * on this implementation's actions: the conflicts are the ones
 * getRange derived (Issue #69), the takeover candidates come from
 * the server's ranking (getDutyChangeCandidates, Issue #31)
 * instead of a client-side re-derivation, and a change is two
 * actions here — proposeDutyChange records it, applyDutyChange
 * applies it.
 *
 * Who may do what follows DESIGN-AUTH-TENANCY 4.4: an Editor or
 * Admin proposes and applies in one motion, waives a conflict
 * with a reason, and applies or declines other people's
 * proposals. A Viewer only ever proposes — and only from an
 * assignment they hold; the panel does not offer them operations
 * on anyone else's assignment, and the server enforces the same
 * rule per row regardless.
 */
export function DutyPanel({
  bootstrap,
  range,
  api,
  onClose,
  onChanged,
}: {
  bootstrap: BootstrapData;
  range: RangeData;
  api: ScheduleApi;
  onClose: () => void;
  /** The range behind the panel changed; the app reloads it. */
  onChanged: () => void;
}) {
  const canWrite = bootstrap.role === "Admin" || bootstrap.role === "Editor";
  const alerts = useMemo(
    () => range.conflicts.filter((c) => c.kind !== "unassigned"),
    [range.conflicts],
  );
  const unassignedByDuty = useMemo(() => {
    const map = new Map<string, DutyConflictData[]>();
    for (const c of range.conflicts) {
      if (c.kind !== "unassigned") continue;
      map.set(c.dutyName, [...(map.get(c.dutyName) ?? []), c]);
    }
    return [...map.entries()];
  }, [range.conflicts]);
  const allAssignments = useMemo(
    () => range.days.flatMap((day) => day.dutyAssignments),
    [range.days],
  );

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Record<string, string[]>>({});
  const [changeReason, setChangeReason] = useState("");
  const [waiveReason, setWaiveReason] = useState("");
  const [changes, setChanges] = useState<DutyChangeData[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshChanges = useCallback(async () => {
    try {
      setChanges(await api.getDutyChanges({}));
    } catch {
      // The history is a courtesy read; a failure leaves the last
      // list standing instead of blocking the panel's operations.
    }
  }, [api]);

  useEffect(() => {
    void refreshChanges();
  }, [refreshChanges]);

  const fail = (cause: unknown) => {
    if (cause instanceof ForbiddenError) setError("権限がありません");
    else if (cause instanceof ApiError || cause instanceof Error) setError(cause.message);
    else setError("操作に失敗しました");
  };

  const conflictKey = (c: DutyConflictData, i: number) =>
    `${c.kind}:${c.assignmentId ?? ""}:${c.absenceId ?? ""}:${c.date}:${c.slot}:${i}`;

  /** A Viewer arranges only from their own assignment (4.4's △);
   *  the panel hides the rest, the server refuses them anyway. */
  const canArrange = (c: DutyConflictData): boolean =>
    c.assignmentId !== null &&
    (canWrite || (bootstrap.teacherId !== null && c.personId === bootstrap.teacherId));

  const openArrange = async (c: DutyConflictData, key: string) => {
    if (activeKey === key) {
      setActiveKey(null);
      return;
    }
    setActiveKey(key);
    setNotice(null);
    if (c.assignmentId && !candidates[key]) {
      try {
        const ids = await api.getDutyChangeCandidates({ assignmentId: c.assignmentId });
        setCandidates((current) => ({ ...current, [key]: ids }));
      } catch (cause) {
        fail(cause);
      }
    }
  };

  const submitChange = async (
    c: DutyConflictData,
    args: { kind: "swap" | "substitute"; assignmentBId?: string; toPersonId?: string },
  ) => {
    if (!c.assignmentId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const proposed = await api.proposeDutyChange({
        kind: args.kind,
        assignmentAId: c.assignmentId,
        assignmentBId: args.assignmentBId ?? null,
        toPersonId: args.toPersonId ?? null,
        reason: changeReason,
      });
      if (canWrite) {
        try {
          await api.applyDutyChange({ id: proposed.id });
        } catch {
          // The proposal itself stands on the server even though
          // applying it failed. Say so plainly, and let the
          // finally below re-read the history so the change shows
          // there and can be applied from the history instead of
          // being proposed a second time.
          setError("申し出は記録されました。適用できなかったので、履歴から適用し直してください。");
          return;
        }
      } else {
        setNotice("交代を申し出しました。編集できる先生が適用すると表に反映されます。");
      }
      setActiveKey(null);
      onChanged();
    } catch (cause) {
      fail(cause);
    } finally {
      // Re-read on every path: a proposal may have been recorded
      // even when the apply step after it failed.
      await refreshChanges();
      setBusy(false);
    }
  };

  const submitWaive = async (c: DutyConflictData) => {
    if (!c.assignmentId || !c.absenceId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.waiveConflict({
        assignmentId: c.assignmentId,
        absenceId: c.absenceId,
        reason: waiveReason,
      });
      setActiveKey(null);
      onChanged();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const decideChange = async (change: DutyChangeData, apply: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (apply) await api.applyDutyChange({ id: change.id });
      else await api.declineDutyChange({ id: change.id });
      await refreshChanges();
      onChanged();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  // ---- rotation preview / apply ----------------------------------
  const rotDefs = useMemo(
    () =>
      bootstrap.dutyDefinitions.filter(
        // A stopped duty (Issue #86) is not offered for rotation:
        // it generates no new assignments.
        (d) => d.isActive !== false && d.rotation !== null && d.rotation.personIds.length > 0,
      ),
    [bootstrap.dutyDefinitions],
  );
  const [rotDefId, setRotDefId] = useState<string>(rotDefs[0]?.id ?? "");
  const [rotFrom, setRotFrom] = useState(range.from);
  const [rotTo, setRotTo] = useState(range.to);
  const [preview, setPreview] = useState<RotationPlanCellData[] | null>(null);
  // The conditions the standing preview was produced under. The
  // apply step runs under exactly these, and any edit to the
  // definition or the period discards the preview (and this
  // record) so nothing is ever applied that was not previewed.
  const [previewConditions, setPreviewConditions] = useState<{
    dutyDefinitionId: string;
    from: string;
    to: string;
  } | null>(null);
  const [applyMsg, setApplyMsg] = useState("");

  const discardPreview = () => {
    setPreview(null);
    setPreviewConditions(null);
    setApplyMsg("");
  };
  const changeRotDefId = (value: string) => {
    setRotDefId(value);
    discardPreview();
  };
  const changeRotFrom = (value: string) => {
    setRotFrom(value);
    discardPreview();
  };
  const changeRotTo = (value: string) => {
    setRotTo(value);
    discardPreview();
  };

  // The panel's overlay covers the whole screen, so the period
  // behind it cannot be moved while the panel is open. Follow the
  // range anyway: if the period ever changes under an open panel,
  // the rotation draft restarts from the new period and the
  // preview goes with it.
  useEffect(() => {
    setRotFrom(range.from);
    setRotTo(range.to);
    discardPreview();
  }, [range.from, range.to]);

  const runPreview = async () => {
    if (busy || !rotDefId) return;
    setBusy(true);
    setError(null);
    try {
      const conditions = { dutyDefinitionId: rotDefId, from: rotFrom, to: rotTo };
      setPreview(await api.previewRotation(conditions));
      setPreviewConditions(conditions);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    if (busy || !previewConditions) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.applyRotation(previewConditions);
      setApplyMsg(
        `${result.created}件を作成し、${result.updated}件を入れ替えました（${result.skipped}件はそのままにしました）。`,
      );
      setPreview(null);
      setPreviewConditions(null);
      onChanged();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const changeKindLabel = (kind: DutyChangeData["kind"]): string =>
    kind === "swap" ? "交換" : kind === "substitute" ? "代行" : "指名し直し";
  const changeStatusLabel = (status: DutyChangeData["status"]): string =>
    status === "proposed" ? "提案中" : status === "applied" ? "適用済" : "見送り";

  return (
    <div className="duty-panel-overlay">
      <div className="duty-panel" role="dialog" aria-modal="true" aria-label="当番と競合">
        <div className="duty-panel-head">
          <h2>当番・競合・交代</h2>
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

        <section aria-label="競合の警告">
          <h3>
            競合の警告
            {alerts.length > 0 && <span className="conflict-badge">{alerts.length}件</span>}
          </h3>
          {alerts.length === 0 && (
            <p className="dim">表示範囲に、不在と当番の重なりや二重割当はありません。</p>
          )}
          <ul className="conflict-list">
            {alerts.map((c, i) => {
              const key = conflictKey(c, i);
              const isOpen = activeKey === key;
              const arrangeable = canArrange(c);
              return (
                <li key={key} className="conflict-item">
                  <p>
                    <span className="conflict-date">{dayLabel(c.date)}</span>
                    {slotLabel(c.slot) && `（${slotLabel(c.slot)}）`}：{c.dutyName}の当番{" "}
                    <span className="conflict-person">{staffName(bootstrap, c.personId)}</span>{" "}
                    さんに
                    {c.kind === "absence" ? (
                      <>
                        {c.certainty === "tentative" ? "仮の" : ""}
                        {absenceKindLabel(c.absenceKind)}が重なっています。
                      </>
                    ) : (
                      <>当番が二重に割り当たっています。</>
                    )}
                  </p>
                  {arrangeable && (
                    <button
                      type="button"
                      className="accent-button"
                      onClick={() => void openArrange(c, key)}
                    >
                      交代を手配する
                    </button>
                  )}
                  {isOpen && arrangeable && (
                    <div className="arrange-box">
                      <div>
                        <label className="field-label" htmlFor={`reason-${i}`}>
                          理由（履歴に残ります）
                        </label>
                        <input
                          id={`reason-${i}`}
                          value={changeReason}
                          onChange={(e) => setChangeReason(e.target.value)}
                          placeholder="例：出張のため"
                        />
                      </div>
                      <p className="dim">候補（その日に不在予定がなく、輪番順が近い人から表示）</p>
                      {(candidates[key] ?? []).length === 0 && (
                        <p className="dim">候補がいません。</p>
                      )}
                      {(candidates[key] ?? []).map((personId) => {
                        const swapTargets = allAssignments.filter(
                          (a) =>
                            a.dutyDefinitionId === c.dutyDefinitionId &&
                            a.personId === personId &&
                            a.id !== c.assignmentId,
                        );
                        return (
                          <div key={personId} className="candidate-row">
                            <span className="candidate-name">{staffName(bootstrap, personId)}</span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void submitChange(c, { kind: "substitute", toPersonId: personId })
                              }
                            >
                              {canWrite ? "この回だけ代行してもらう" : "この回だけ代行を申し出る"}
                            </button>
                            {swapTargets.map((target) => (
                              <button
                                key={target.id}
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void submitChange(c, {
                                    kind: "swap",
                                    assignmentBId: target.id,
                                  })
                                }
                              >
                                {dayLabel(target.date)}の当番と
                                {canWrite ? "交換" : "交換を申し出る"}
                              </button>
                            ))}
                          </div>
                        );
                      })}
                      {canWrite && c.kind === "absence" && c.absenceId && (
                        <div className="waive-row">
                          <input
                            aria-label="このままにする理由"
                            placeholder="このままにする理由（例：午前のみの出張で両立できる）"
                            value={waiveReason}
                            onChange={(e) => setWaiveReason(e.target.value)}
                          />
                          <button type="button" disabled={busy} onClick={() => void submitWaive(c)}>
                            警告のまま、このままにする
                          </button>
                        </div>
                      )}
                      <p className="dim">競合は警告であり、保存を止めるものではありません。</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {unassignedByDuty.length > 0 && (
          <section aria-label="未割当の当番">
            <h3>未割当の当番</h3>
            {unassignedByDuty.map(([name, list]) => (
              <p key={name}>
                {name}：{list.length}件（
                {list
                  .slice(0, 8)
                  .map((c) => dayLabel(c.date))
                  .join("、")}
                {list.length > 8 ? " ほか" : ""}）
              </p>
            ))}
            <p className="dim">下の輪番の自動生成でまとめて下書きできます。</p>
          </section>
        )}

        <section aria-label="輪番の自動生成">
          <h3>輪番の自動生成（下書き）</h3>
          {rotDefs.length === 0 ? (
            <p className="dim">
              輪番リストを持つ当番定義がありません。当番定義に担当者の順番を登録してください。
            </p>
          ) : (
            <div className="rotation-box">
              <div className="rotation-controls">
                <select
                  aria-label="自動生成する当番"
                  value={rotDefId}
                  onChange={(e) => changeRotDefId(e.target.value)}
                >
                  {rotDefs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="生成開始日"
                  type="date"
                  value={rotFrom}
                  onChange={(e) => changeRotFrom(e.target.value)}
                />
                <span>〜</span>
                <input
                  aria-label="生成終了日"
                  type="date"
                  value={rotTo}
                  onChange={(e) => changeRotTo(e.target.value)}
                />
              </div>
              <div className="rotation-controls">
                <button type="button" disabled={busy} onClick={() => void runPreview()}>
                  プレビュー
                </button>
                {preview && previewConditions && canWrite && (
                  <button
                    type="button"
                    className="accent-button"
                    disabled={busy}
                    onClick={() => void runApply()}
                  >
                    この内容で割り当てる（{preview.filter((cell) => cell.action !== "keep").length}
                    件）
                  </button>
                )}
              </div>
              {applyMsg && <p>{applyMsg}</p>}
              {preview && (
                <ul className="rotation-preview">
                  {preview.map((cell, i) => (
                    <li key={`${cell.date}-${cell.slot}-${i}`}>
                      {dayLabel(cell.date)}
                      {slotLabel(cell.slot) && `（${slotLabel(cell.slot)}）`}：
                      {staffName(bootstrap, cell.personId)}
                      {cell.action === "create" && <span className="dim">（新規）</span>}
                      {cell.action === "replace" && <span className="dim">（入れ替え）</span>}
                      {cell.action === "keep" && <span className="dim">（そのまま）</span>}
                    </li>
                  ))}
                </ul>
              )}
              <p className="dim">
                既に割当がある日は上書きしません（手動の割当・交代済みの割当は常に優先されます）。
              </p>
            </div>
          )}
        </section>

        <section aria-label="交代の履歴">
          <h3>交代の履歴</h3>
          {changes.length === 0 ? (
            <p className="dim">まだ交代の記録はありません。</p>
          ) : (
            <ul className="change-list">
              {changes.map((ch) => {
                const defName =
                  bootstrap.dutyDefinitions.find((d) => d.id === ch.dutyDefinitionId)?.name ?? "";
                return (
                  <li key={ch.id} className="change-item">
                    <span className="change-kind">{changeKindLabel(ch.kind)}</span>（{defName}）：
                    {staffName(bootstrap, ch.fromPersonId)} → {staffName(bootstrap, ch.toPersonId)}
                    <span className="change-status">{changeStatusLabel(ch.status)}</span>
                    {ch.reason && <span className="dim">／理由：{ch.reason}</span>}
                    <span className="dim">
                      {new Date(ch.createdAt).toLocaleDateString("ja-JP")}
                    </span>
                    {canWrite && ch.status === "proposed" && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void decideChange(ch, true)}
                        >
                          適用する
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void decideChange(ch, false)}
                        >
                          見送る
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
