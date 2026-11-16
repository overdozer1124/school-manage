import type { ScheduleApi } from "../api";
import type {
  BootstrapData,
  DefinitionSetData,
  DutyDefinitionData,
  KindTemplateData,
  MastersData,
  ViewDefinitionData,
} from "../types";

/**
 * What the settings sections share (Issue #39, split out of
 * SettingsPanel.tsx): the label tables the sections render
 * with, the client-made row ids new definition rows carry, and
 * the context the panel hands every section — the loaded
 * definition set and masters, the bootstrap's views / duties /
 * templates with their setters, and the panel's run / delete
 * helpers, so a section's saves behave exactly like the
 * panel's (busy state, error line, reload behind the panel).
 */

let fallbackSeq = 0;
/** New definition rows carry a client-made id, as the platform
 *  records do (the input schemas require one). */
export function newRowId(prefix: string): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `${prefix}-${cryptoObj.randomUUID()}`;
  }
  fallbackSeq += 1;
  return `${prefix}-${Date.now()}-${fallbackSeq}`;
}

export const VALUE_TYPE_LABELS: Record<string, string> = {
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
export const GRANULARITY_LABELS: Record<string, string> = {
  day: "日ごと",
  am_pm: "午前・午後",
  period: "時限ごと",
  week: "週ごと",
  month: "月ごと",
};
export const VISIBILITY_LABELS: Record<string, string> = {
  staff_only: "職員のみ",
  guardian: "保護者まで",
  student: "生徒まで",
  public: "公開",
};
export const LAYOUT_LABELS: Record<string, string> = {
  month_rows: "月表（行）",
  week_rows: "週表（行）",
  year_columns: "年間表（列）",
  calendar_grid: "カレンダー格子",
  week_timeline: "週タイムライン",
  transposed: "転置表",
};
export const AUDIENCE_LABELS: Record<string, string> = {
  staff: "職員",
  guardian: "保護者",
  student: "生徒",
  public: "公開",
};
export const PERIOD_SCOPE_LABELS: Record<string, string> = {
  week: "週",
  two_weeks: "2週間",
  month: "月",
  year: "年",
};
export const DUTY_PERIOD_LABELS: Record<string, string> = {
  all_year: "通年",
  term: "学期のみ",
  long_vacation_only: "長期休業のみ",
  custom_range: "期間を指定",
};
export const ABSENCE_KINDS: { code: string; label: string }[] = [
  { code: "business_trip", label: "出張" },
  { code: "training", label: "研修" },
  { code: "leave", label: "休暇" },
  { code: "other", label: "その他" },
];
export const WEEKDAYS: { code: string; label: string }[] = [
  { code: "mon", label: "月" },
  { code: "tue", label: "火" },
  { code: "wed", label: "水" },
  { code: "thu", label: "木" },
  { code: "fri", label: "金" },
  { code: "sat", label: "土" },
  { code: "sun", label: "日" },
];
export const STEP_KIND_LABELS: Record<string, string> = {
  person: "担当者",
  location: "場所",
  time: "時間",
  subdivision: "分類",
  item: "追加項目",
};
export const PRESETS: {
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

export type RunFn = (action: () => Promise<unknown>, done?: () => void) => Promise<void>;

export interface SectionCtx {
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

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
