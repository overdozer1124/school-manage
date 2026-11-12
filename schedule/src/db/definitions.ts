import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  itemDefinitions,
  itemOptions,
  locations,
  schoolSettings,
  targetGroups,
  targets,
  type ItemDefinitionRow,
  type ItemOptionRow,
  type LocationRow,
  type SchoolSettingsRow,
  type TargetGroupRow,
  type TargetRow,
} from "./schema.js";
import { PRESETS } from "../definitions/presets.js";
import type {
  ItemDefinitionInput,
  LocationInput,
  PresetKey,
  TargetGroupInput,
  TargetInput,
} from "../definitions/types.js";

/**
 * The definition store (Issue #27): item definitions, target axes,
 * locations, per-school settings and preset application. Every query
 * carries the school_id condition (DESIGN-AUTH-TENANCY 3.3); the
 * composite foreign keys in the schema are the second line of
 * defence. Multi-row writes (an item with its options, a preset) run
 * in one transaction so a failure cannot leave half a definition.
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

/**
 * The name of the constraint a Postgres error blames, when the
 * driver reports one (postgres.js exposes it as `constraint_name`,
 * node-postgres as `constraint`). Two unique violations share the
 * 23505 code, so the constraint name is what tells them apart.
 */
function pgErrorConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    const fields = current as { constraint_name?: unknown; constraint?: unknown };
    if (typeof fields.constraint_name === "string") return fields.constraint_name;
    if (typeof fields.constraint === "string") return fields.constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface TargetGroupWithTargets extends TargetGroupRow {
  targets: TargetRow[];
}

export interface ItemDefinitionWithOptions extends ItemDefinitionRow {
  options: ItemOptionRow[];
}

export interface DefinitionSet {
  settings: SchoolSettingsRow | null;
  targetGroups: TargetGroupWithTargets[];
  itemDefinitions: ItemDefinitionWithOptions[];
  locations: LocationRow[];
}

export async function getDefinitionSet(db: Db, schoolId: string): Promise<DefinitionSet> {
  const [settingsRows, groupRows, targetRows, itemRows, optionRows, locationRows] =
    await Promise.all([
      db.select().from(schoolSettings).where(eq(schoolSettings.schoolId, schoolId)),
      db
        .select()
        .from(targetGroups)
        .where(eq(targetGroups.schoolId, schoolId))
        .orderBy(asc(targetGroups.sort), asc(targetGroups.key)),
      db
        .select()
        .from(targets)
        .where(eq(targets.schoolId, schoolId))
        .orderBy(asc(targets.sort), asc(targets.name)),
      db
        .select()
        .from(itemDefinitions)
        .where(eq(itemDefinitions.schoolId, schoolId))
        .orderBy(asc(itemDefinitions.sort), asc(itemDefinitions.key)),
      db
        .select()
        .from(itemOptions)
        .where(eq(itemOptions.schoolId, schoolId))
        .orderBy(asc(itemOptions.sort), asc(itemOptions.code)),
      db
        .select()
        .from(locations)
        .where(eq(locations.schoolId, schoolId))
        .orderBy(asc(locations.sort), asc(locations.name)),
    ]);
  return {
    settings: settingsRows[0] ?? null,
    targetGroups: groupRows.map((group) => ({
      ...group,
      targets: targetRows.filter((t) => t.targetGroupId === group.id),
    })),
    itemDefinitions: itemRows.map((item) => ({
      ...item,
      options: optionRows.filter((o) => o.itemDefinitionId === item.id),
    })),
    locations: locationRows,
  };
}

export async function upsertTargetGroup(
  db: Db,
  schoolId: string,
  input: TargetGroupInput,
): Promise<TargetGroupRow> {
  try {
    const rows = await db
      .insert(targetGroups)
      .values({ schoolId, id: input.id, key: input.key, name: input.name, sort: input.sort ?? 0 })
      .onConflictDoUpdate({
        target: [targetGroups.schoolId, targetGroups.id],
        set: { key: input.key, name: input.name, sort: input.sort ?? 0 },
      })
      .returning();
    return rows[0] as TargetGroupRow;
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new Error(`target group key already exists in this school: ${input.key}`);
    }
    throw error;
  }
}

export async function deleteTargetGroup(db: Db, schoolId: string, id: string): Promise<boolean> {
  try {
    const rows = await db
      .delete(targetGroups)
      .where(and(eq(targetGroups.schoolId, schoolId), eq(targetGroups.id, id)))
      .returning();
    return rows.length > 0;
  } catch (error) {
    if (pgErrorCode(error) === "23503") {
      throw new Error(`target group is in use and cannot be deleted: ${id}`);
    }
    throw error;
  }
}

export async function upsertTarget(
  db: Db,
  schoolId: string,
  input: TargetInput,
): Promise<TargetRow> {
  const rows = await db
    .insert(targets)
    .values({
      schoolId,
      id: input.id,
      targetGroupId: input.targetGroupId,
      code: input.code ?? null,
      name: input.name,
      sort: input.sort ?? 0,
      parentTargetId: input.parentTargetId ?? null,
    })
    .onConflictDoUpdate({
      target: [targets.schoolId, targets.id],
      set: {
        targetGroupId: input.targetGroupId,
        code: input.code ?? null,
        name: input.name,
        sort: input.sort ?? 0,
        parentTargetId: input.parentTargetId ?? null,
      },
    })
    .returning();
  return rows[0] as TargetRow;
}

export async function deleteTarget(db: Db, schoolId: string, id: string): Promise<boolean> {
  try {
    const rows = await db
      .delete(targets)
      .where(and(eq(targets.schoolId, schoolId), eq(targets.id, id)))
      .returning();
    return rows.length > 0;
  } catch (error) {
    if (pgErrorCode(error) === "23503") {
      throw new Error(`target is in use and cannot be deleted: ${id}`);
    }
    throw error;
  }
}

export async function upsertItemDefinition(
  db: Db,
  schoolId: string,
  input: ItemDefinitionInput,
): Promise<ItemDefinitionWithOptions> {
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .insert(itemDefinitions)
        .values({
          schoolId,
          id: input.id,
          key: input.key,
          name: input.name,
          valueType: input.valueType,
          targetGroupId: input.targetGroupId ?? null,
          targetPlatformAxis: input.targetPlatformAxis ?? null,
          granularity: input.granularity,
          defaultVisibility: input.defaultVisibility,
          isAggregatable: input.isAggregatable ?? false,
          sort: input.sort ?? 0,
          isActive: input.isActive ?? true,
        })
        .onConflictDoUpdate({
          target: [itemDefinitions.schoolId, itemDefinitions.id],
          set: {
            key: input.key,
            name: input.name,
            valueType: input.valueType,
            targetGroupId: input.targetGroupId ?? null,
            targetPlatformAxis: input.targetPlatformAxis ?? null,
            granularity: input.granularity,
            defaultVisibility: input.defaultVisibility,
            isAggregatable: input.isAggregatable ?? false,
            sort: input.sort ?? 0,
            isActive: input.isActive ?? true,
          },
        })
        .returning();
      const item = rows[0] as ItemDefinitionRow;
      if (input.options) {
        await tx
          .delete(itemOptions)
          .where(
            and(eq(itemOptions.schoolId, schoolId), eq(itemOptions.itemDefinitionId, item.id)),
          );
        if (input.options.length > 0) {
          await tx.insert(itemOptions).values(
            input.options.map((o) => ({
              schoolId,
              id: o.id,
              itemDefinitionId: item.id,
              code: o.code,
              label: o.label,
              meaning: o.meaning ?? null,
              colorHint: o.colorHint ?? null,
              countsAs: o.countsAs ?? null,
              sort: o.sort ?? 0,
            })),
          );
        }
      }
      const options = await tx
        .select()
        .from(itemOptions)
        .where(and(eq(itemOptions.schoolId, schoolId), eq(itemOptions.itemDefinitionId, item.id)))
        .orderBy(asc(itemOptions.sort), asc(itemOptions.code));
      return { ...item, options };
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      // Tell the caller which uniqueness rule fired: the item's own
      // key, an option id already used by another item of this
      // school, or a duplicate option code within this item.
      const constraint = pgErrorConstraint(error) ?? "";
      if (constraint.startsWith("item_options_school_id_id_pk")) {
        throw new Error("an item option id already exists in this school (used by another item)");
      }
      if (constraint.startsWith("item_options")) {
        throw new Error(`item option code already exists for this item definition: ${input.key}`);
      }
      throw new Error(`item definition key already exists in this school: ${input.key}`);
    }
    throw error;
  }
}

export async function deleteItemDefinition(db: Db, schoolId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(itemDefinitions)
    .where(and(eq(itemDefinitions.schoolId, schoolId), eq(itemDefinitions.id, id)))
    .returning();
  return rows.length > 0;
}

export async function upsertLocation(
  db: Db,
  schoolId: string,
  input: LocationInput,
): Promise<LocationRow> {
  const rows = await db
    .insert(locations)
    .values({
      schoolId,
      id: input.id,
      name: input.name,
      kind: input.kind ?? null,
      sort: input.sort ?? 0,
      isActive: input.isActive ?? true,
    })
    .onConflictDoUpdate({
      target: [locations.schoolId, locations.id],
      set: {
        name: input.name,
        kind: input.kind ?? null,
        sort: input.sort ?? 0,
        isActive: input.isActive ?? true,
      },
    })
    .returning();
  return rows[0] as LocationRow;
}

export async function deleteLocation(db: Db, schoolId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(locations)
    .where(and(eq(locations.schoolId, schoolId), eq(locations.id, id)))
    .returning();
  return rows.length > 0;
}

export async function saveSettings(
  db: Db,
  schoolId: string,
  inputOpener: "popover" | "modal",
): Promise<SchoolSettingsRow> {
  const rows = await db
    .insert(schoolSettings)
    .values({ schoolId, inputOpener })
    .onConflictDoUpdate({
      target: schoolSettings.schoolId,
      set: { inputOpener, updatedAt: new Date() },
    })
    .returning();
  return rows[0] as SchoolSettingsRow;
}

export interface ApplyPresetSummary {
  preset: PresetKey;
  insertedTargetGroups: number;
  insertedTargets: number;
  insertedItemDefinitions: number;
  /** Keys of preset items that already existed and were left untouched. */
  skippedItemKeys: string[];
  /**
   * Keys of preset target groups the school already had under its
   * own id; the preset's targets and items were re-pointed at the
   * school's group instead of the preset id.
   */
  skippedTargetGroupKeys: string[];
  /**
   * Ids of preset targets that already existed (same id, or same
   * code within the resolved group) and were left untouched.
   */
  skippedTargetIds: string[];
}

/**
 * Applies a preset (DESIGN schedule 5.1): inserts the groups,
 * targets, items and options the school does not have yet, and
 * never overwrites an existing definition. Records the application
 * on school_settings.
 *
 * Existing rows are matched by key, not only by id: a school may
 * already have an axis with the preset's key under its own id (a
 * club axis created from the management screen, say). The preset's
 * targets and items then point at the school's existing group id —
 * inserting the preset id alongside would either duplicate the key
 * or leave the references pointing at a row that was never inserted
 * (PR #56 review, mandatory 1). Targets are matched the same way,
 * by id or by code within the resolved group, and a preset target's
 * parent reference is re-pointed at the resolved target id.
 */
export async function applyPreset(
  db: Db,
  schoolId: string,
  presetKey: PresetKey,
): Promise<ApplyPresetSummary> {
  const preset = PRESETS[presetKey];
  return db.transaction(async (tx) => {
    let insertedTargetGroups = 0;
    let insertedTargets = 0;
    let insertedItemDefinitions = 0;
    const skippedItemKeys: string[] = [];
    const skippedTargetGroupKeys: string[] = [];
    const skippedTargetIds: string[] = [];

    const existingGroups = await tx
      .select()
      .from(targetGroups)
      .where(eq(targetGroups.schoolId, schoolId));
    const existingTargets = await tx.select().from(targets).where(eq(targets.schoolId, schoolId));
    const groupIdByKey = new Map(existingGroups.map((g) => [g.key, g.id]));
    const groupIds = new Set(existingGroups.map((g) => g.id));

    // Resolve every preset group to the id its targets and items
    // must reference: the school's own row when the key already
    // exists, otherwise the preset row inserted here.
    const resolvedGroupId = new Map<string, string>();
    for (const { group } of preset.targetGroups) {
      const byKey = groupIdByKey.get(group.key);
      if (byKey !== undefined) {
        resolvedGroupId.set(group.id, byKey);
        if (byKey !== group.id) skippedTargetGroupKeys.push(group.key);
        continue;
      }
      if (groupIds.has(group.id)) {
        // A row with the preset id but another key: references to
        // the preset id still land on a real row, so keep it.
        resolvedGroupId.set(group.id, group.id);
        skippedTargetGroupKeys.push(group.key);
        continue;
      }
      await tx.insert(targetGroups).values({
        schoolId,
        id: group.id,
        key: group.key,
        name: group.name,
        sort: group.sort ?? 0,
      });
      insertedTargetGroups += 1;
      groupIdByKey.set(group.key, group.id);
      groupIds.add(group.id);
      resolvedGroupId.set(group.id, group.id);
    }

    // Targets, matched within their resolved group by id or code.
    const resolvedTargetId = new Map<string, string>();
    for (const { group, targets: presetTargets } of preset.targetGroups) {
      const groupId = resolvedGroupId.get(group.id) as string;
      for (const target of presetTargets) {
        const existing =
          existingTargets.find((t) => t.targetGroupId === groupId && t.id === target.id) ??
          (target.code != null
            ? existingTargets.find((t) => t.targetGroupId === groupId && t.code === target.code)
            : undefined) ??
          existingTargets.find((t) => t.id === target.id);
        if (existing) {
          resolvedTargetId.set(target.id, existing.id);
          skippedTargetIds.push(target.id);
          continue;
        }
        const insertedTarget = await tx
          .insert(targets)
          .values({
            schoolId,
            id: target.id,
            targetGroupId: groupId,
            code: target.code ?? null,
            name: target.name,
            sort: target.sort ?? 0,
            parentTargetId: target.parentTargetId
              ? (resolvedTargetId.get(target.parentTargetId) ?? target.parentTargetId)
              : null,
          })
          .returning();
        const row = insertedTarget[0] as TargetRow;
        existingTargets.push(row);
        resolvedTargetId.set(target.id, row.id);
        insertedTargets += 1;
      }
    }

    for (const item of preset.itemDefinitions) {
      const inserted = await tx
        .insert(itemDefinitions)
        .values({
          schoolId,
          id: item.id,
          key: item.key,
          name: item.name,
          valueType: item.valueType,
          targetGroupId: item.targetGroupId
            ? (resolvedGroupId.get(item.targetGroupId) ?? item.targetGroupId)
            : null,
          targetPlatformAxis: item.targetPlatformAxis ?? null,
          granularity: item.granularity,
          defaultVisibility: item.defaultVisibility,
          isAggregatable: item.isAggregatable ?? false,
          sort: item.sort ?? 0,
          isActive: item.isActive ?? true,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) {
        skippedItemKeys.push(item.key);
        continue;
      }
      insertedItemDefinitions += 1;
      if (item.options && item.options.length > 0) {
        await tx
          .insert(itemOptions)
          .values(
            item.options.map((o) => ({
              schoolId,
              id: o.id,
              itemDefinitionId: item.id,
              code: o.code,
              label: o.label,
              meaning: o.meaning ?? null,
              colorHint: o.colorHint ?? null,
              countsAs: o.countsAs ?? null,
              sort: o.sort ?? 0,
            })),
          )
          .onConflictDoNothing();
      }
    }

    await tx
      .insert(schoolSettings)
      .values({ schoolId, presetKey, presetAppliedAt: new Date() })
      .onConflictDoUpdate({
        target: schoolSettings.schoolId,
        set: { presetKey, presetAppliedAt: new Date(), updatedAt: new Date() },
      });

    return {
      preset: presetKey,
      insertedTargetGroups,
      insertedTargets,
      insertedItemDefinitions,
      skippedItemKeys,
      skippedTargetGroupKeys,
      skippedTargetIds,
    };
  });
}
