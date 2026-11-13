import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  viewColumns,
  viewDefinitions,
  type ViewColumnRow,
  type ViewDefinitionRow,
} from "./schema.js";
import type { UpdateColumnWidthInput, ViewDefinitionInput } from "../views/types.js";

/**
 * The view store (Issue #32): view definitions and their columns.
 * Every query carries the school_id condition (DESIGN-AUTH-TENANCY
 * 3.3); the composite foreign keys are the second line of defence.
 * A definition and its columns are written in one transaction, so a
 * refused column cannot leave a half-written view.
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

export interface ViewDefinitionWithColumns extends ViewDefinitionRow {
  columns: ViewColumnRow[];
}

export async function getViews(db: Db, schoolId: string): Promise<ViewDefinitionWithColumns[]> {
  const [definitionRows, columnRows] = await Promise.all([
    db
      .select()
      .from(viewDefinitions)
      .where(eq(viewDefinitions.schoolId, schoolId))
      .orderBy(asc(viewDefinitions.name)),
    db
      .select()
      .from(viewColumns)
      .where(eq(viewColumns.schoolId, schoolId))
      .orderBy(asc(viewColumns.sort), asc(viewColumns.id)),
  ]);
  return definitionRows.map((definition) => ({
    ...definition,
    columns: columnRows.filter((c) => c.viewDefinitionId === definition.id),
  }));
}

export async function upsertViewDefinition(
  db: Db,
  schoolId: string,
  input: ViewDefinitionInput,
): Promise<ViewDefinitionWithColumns> {
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .insert(viewDefinitions)
        .values({
          schoolId,
          id: input.id,
          name: input.name,
          layout: input.layout,
          layoutParams: input.layoutParams ?? null,
          audience: input.audience,
          periodScope: input.periodScope,
          printSettings: input.printSettings ?? null,
        })
        .onConflictDoUpdate({
          target: [viewDefinitions.schoolId, viewDefinitions.id],
          set: {
            name: input.name,
            layout: input.layout,
            layoutParams: input.layoutParams ?? null,
            audience: input.audience,
            periodScope: input.periodScope,
            printSettings: input.printSettings ?? null,
          },
        })
        .returning();
      const definition = rows[0] as ViewDefinitionRow;
      if (input.columns) {
        await tx
          .delete(viewColumns)
          .where(
            and(eq(viewColumns.schoolId, schoolId), eq(viewColumns.viewDefinitionId, input.id)),
          );
        if (input.columns.length > 0) {
          await tx.insert(viewColumns).values(
            input.columns.map((c) => ({
              schoolId,
              id: c.id,
              viewDefinitionId: input.id,
              sourceKind: c.sourceKind,
              itemDefinitionId: c.itemDefinitionId ?? null,
              dutyDefinitionId: c.dutyDefinitionId ?? null,
              targetGroupId: c.targetGroupId ?? null,
              groupSameValues: c.groupSameValues ?? true,
              widthHint: c.widthHint ?? null,
              sort: c.sort ?? 0,
            })),
          );
        }
      }
      const columns = await tx
        .select()
        .from(viewColumns)
        .where(and(eq(viewColumns.schoolId, schoolId), eq(viewColumns.viewDefinitionId, input.id)))
        .orderBy(asc(viewColumns.sort), asc(viewColumns.id));
      return { ...definition, columns };
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new Error(`view name already exists in this school: ${input.name}`);
    }
    if (pgErrorCode(error) === "23503") {
      throw new Error("a view column references a definition that does not exist in this school");
    }
    throw error;
  }
}

export async function deleteViewDefinition(db: Db, schoolId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(viewDefinitions)
    .where(and(eq(viewDefinitions.schoolId, schoolId), eq(viewDefinitions.id, id)))
    .returning();
  return rows.length > 0;
}

/**
 * Changes one column's width hint (the view.layout action's whole
 * job: layout tweaks must not touch the definition itself, which is
 * definition.write / Admin-only). Returns the updated column, or
 * null when the view or column is not this school's.
 */
export async function updateColumnWidth(
  db: Db,
  schoolId: string,
  input: UpdateColumnWidthInput,
): Promise<ViewColumnRow | null> {
  const rows = await db
    .update(viewColumns)
    .set({ widthHint: input.widthHint })
    .where(
      and(
        eq(viewColumns.schoolId, schoolId),
        eq(viewColumns.viewDefinitionId, input.viewId),
        eq(viewColumns.id, input.columnId),
      ),
    )
    .returning();
  return (rows[0] as ViewColumnRow | undefined) ?? null;
}
