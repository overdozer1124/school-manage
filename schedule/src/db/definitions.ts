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
}

/**
 * Applies a preset (DESIGN schedule 5.1): inserts the groups,
 * targets, items and options the school does not have yet, matched
 * by id and by key, and never overwrites an existing definition.
 * Records the application on school_settings.
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

    for (const { group, targets: presetTargets } of preset.targetGroups) {
      const inserted = await tx
        .insert(targetGroups)
        .values({
          schoolId,
          id: group.id,
          key: group.key,
          name: group.name,
          sort: group.sort ?? 0,
        })
        .onConflictDoNothing()
        .returning();
      insertedTargetGroups += inserted.length;
      for (const target of presetTargets) {
        const insertedTarget = await tx
          .insert(targets)
          .values({
            schoolId,
            id: target.id,
            targetGroupId: target.targetGroupId,
            code: target.code ?? null,
            name: target.name,
            sort: target.sort ?? 0,
            parentTargetId: target.parentTargetId ?? null,
          })
          .onConflictDoNothing()
          .returning();
        insertedTargets += insertedTarget.length;
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
          targetGroupId: item.targetGroupId ?? null,
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
    };
  });
}
