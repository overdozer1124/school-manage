import type { KindTemplateData } from "../types";

/**
 * Shared pieces of the detail modal (Issue #37): what the modal
 * is opened on, and the small record readers every form uses.
 * The modal itself lives in ../DetailModal.tsx; the forms and
 * editors it composes live beside this file.
 */

export interface DetailTarget {
  subjectKind: "event" | "absence";
  template: KindTemplateData;
  record: Record<string, unknown>;
  /** The day the entry was opened from: its day pattern's
   *  periods are the 時限指定 choices. */
  date: string;
  dayScheduleId: string | null;
}

export function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function revisionOf(record: Record<string, unknown>): number | null {
  const value = record["revision"];
  return typeof value === "number" ? value : null;
}

export type Assignee =
  | { kind: "staff"; staffId: string; role: string | null }
  | { kind: "free_text"; name: string; role: string | null };

export function assigneesOf(record: Record<string, unknown>): Assignee[] {
  const list = record["assignees"];
  if (!Array.isArray(list)) return [];
  const out: Assignee[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const a = entry as Record<string, unknown>;
    const role = typeof a["role"] === "string" ? (a["role"] as string) : null;
    if (a["kind"] === "staff" && typeof a["staffId"] === "string") {
      out.push({ kind: "staff", staffId: a["staffId"] as string, role });
    } else if (a["kind"] === "free_text" && typeof a["name"] === "string") {
      out.push({ kind: "free_text", name: a["name"] as string, role });
    }
  }
  return out;
}

export const VISIBILITY_OPTIONS: { value: string; label: string }[] = [
  { value: "staff_only", label: "職員のみ" },
  { value: "guardian", label: "保護者" },
  { value: "student", label: "生徒" },
  { value: "public", label: "公開" },
];
