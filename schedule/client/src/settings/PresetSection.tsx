import { useEffect, useState } from "react";
import { ABSENCE_KINDS, PRESETS, Section, type SectionCtx } from "./shared";

/** Presets and the school settings row (input opener, and which
 *  absence kinds count for duty conflicts). */
export function PresetSection({ ctx }: { ctx: SectionCtx }) {
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
