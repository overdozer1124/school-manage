import { useCallback, useEffect, useState } from "react";
import type { ScheduleApi } from "./api";
import type {
  BootstrapData,
  DefinitionSetData,
  DutyDefinitionData,
  KindTemplateData,
  MastersData,
  ViewDefinitionData,
} from "./types";
import { DutiesSection } from "./settings/DutiesSection";
import { ItemsSection } from "./settings/ItemDefinitionsSection";
import { LocationsSection } from "./settings/LocationsSection";
import { MastersSection } from "./settings/MastersSection";
import { PresetSection } from "./settings/PresetSection";
import { TargetsSection } from "./settings/TargetsSection";
import { TemplatesSection } from "./settings/TemplatesSection";
import { ViewsSection } from "./settings/ViewsSection";
import type { RunFn, SectionCtx } from "./settings/shared";

/**
 * The settings screens (Issue #39), ported from the prototype's
 * SettingsPanel / QuickSetup (school-schedule, frozen) onto this
 * implementation's actions and rebuilt to the screens' own
 * parts: sections down one scroll — presets and school settings,
 * item definitions and their legends, target axes and targets,
 * locations, duty definitions and their rotation rosters, views,
 * kind templates, and the shared masters (edited through the
 * relay to the platform, Issue #22's API). The eight sections
 * live one per file under ./settings/, over the shared context
 * and label tables in ./settings/shared; this file keeps the
 * panel shell and the state every section works on.
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
   *  second (on the same row) deletes. Any other action disarms.
   *  A section may pass a confirm note naming what the delete
   *  cascades to; it is shown while the button is armed, before
   *  the second click (PR #78 re-review). */
  const deleteButton = (
    key: string,
    label: string,
    action: () => Promise<unknown>,
    confirmNote?: string,
  ) => (
    <>
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
      {confirmKey === key && confirmNote && (
        <span className="settings-delete-note">{confirmNote}</span>
      )}
    </>
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
