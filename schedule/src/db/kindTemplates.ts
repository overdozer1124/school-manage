import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { kindTemplates, type KindTemplateRow, type KindTemplateStep } from "./schema.js";
import { DEFAULT_KIND_TEMPLATES } from "../events/templates.js";
import type { KindTemplateInput } from "../events/types.js";

/** The stored form of a step list: every step carries its item
 *  binding, null when unbound (the input may omit it). */
function storedSteps(input: KindTemplateInput): KindTemplateStep[] {
  return input.steps.map((s) => ({ kind: s.kind, itemDefinitionId: s.itemDefinitionId ?? null }));
}

/**
 * The kind-template store (Issue #29). Every query carries the
 * school_id condition (DESIGN-AUTH-TENANCY 3.3). A template's key is
 * unique per school (the same treatment as a view's name, Issue
 * #32): reusing a key under another id is an error, not a second
 * template for the same kind.
 */

function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function getKindTemplates(db: Db, schoolId: string): Promise<KindTemplateRow[]> {
  return db
    .select()
    .from(kindTemplates)
    .where(eq(kindTemplates.schoolId, schoolId))
    .orderBy(asc(kindTemplates.sort), asc(kindTemplates.id));
}

export async function upsertKindTemplate(
  db: Db,
  schoolId: string,
  input: KindTemplateInput,
): Promise<KindTemplateRow> {
  try {
    const rows = await db
      .insert(kindTemplates)
      .values({
        schoolId,
        id: input.id,
        key: input.key,
        name: input.name,
        subjectKind: input.subjectKind,
        kindCode: input.kindCode,
        personLabel: input.personLabel,
        displaySource: input.displaySource,
        steps: storedSteps(input),
        itemDefinitionIds: input.itemDefinitionIds ?? [],
        sort: input.sort ?? 0,
      })
      .onConflictDoUpdate({
        target: [kindTemplates.schoolId, kindTemplates.id],
        set: {
          key: input.key,
          name: input.name,
          subjectKind: input.subjectKind,
          kindCode: input.kindCode,
          personLabel: input.personLabel,
          displaySource: input.displaySource,
          steps: storedSteps(input),
          itemDefinitionIds: input.itemDefinitionIds ?? [],
          sort: input.sort ?? 0,
        },
      })
      .returning();
    return rows[0] as KindTemplateRow;
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new Error(`kind template key already exists in this school: ${input.key}`);
    }
    throw error;
  }
}

export async function deleteKindTemplate(db: Db, schoolId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(kindTemplates)
    .where(and(eq(kindTemplates.schoolId, schoolId), eq(kindTemplates.id, id)))
    .returning();
  return rows.length > 0;
}

/**
 * Inserts the shipped default templates (Issue #29: 行事／出張／〆切／
 * 休暇） that the school does not have yet, matched by key — the
 * same "a preset is only a starting point" rule as applyPreset
 * (Issue #27): a template the school already has, default or its
 * own, is never overwritten. Returns the school's full template
 * list afterwards.
 */
export async function applyDefaultKindTemplates(
  db: Db,
  schoolId: string,
): Promise<KindTemplateRow[]> {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(kindTemplates)
      .where(eq(kindTemplates.schoolId, schoolId));
    const existingKeys = new Set(existing.map((t) => t.key));
    const existingIds = new Set(existing.map((t) => t.id));
    for (const template of DEFAULT_KIND_TEMPLATES) {
      if (existingKeys.has(template.key) || existingIds.has(template.id)) continue;
      await tx.insert(kindTemplates).values({
        schoolId,
        id: template.id,
        key: template.key,
        name: template.name,
        subjectKind: template.subjectKind,
        kindCode: template.kindCode,
        personLabel: template.personLabel,
        displaySource: template.displaySource,
        steps: storedSteps(template),
        itemDefinitionIds: template.itemDefinitionIds ?? [],
        sort: template.sort ?? 0,
      });
    }
  });
  return getKindTemplates(db, schoolId);
}
