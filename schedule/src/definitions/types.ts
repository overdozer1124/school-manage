import { z } from "zod";
import { absenceKindSchema } from "@school-manage/calendar-types";

/**
 * Payload shapes for the definition actions (Issue #27). The enums
 * mirror the design: value types and granularity from DESIGN schedule
 * 4.4, visibilities from 4.5, platform axes from DESIGN-INTEGRATION
 * 2.4 (the shared masters an item can vary over). The database holds
 * the same lists as check constraints, so a value that slips past a
 * caller still cannot be stored.
 */
const nonEmptyString = z.string().min(1);

export const valueTypeSchema = z.enum([
  "text",
  "event_list",
  "time",
  "time_range",
  "symbol",
  "code",
  "person",
  "persons",
  "number",
  "boolean",
  "target_time_map",
]);
export type ValueType = z.infer<typeof valueTypeSchema>;

export const granularitySchema = z.enum(["day", "am_pm", "period", "week", "month"]);
export type Granularity = z.infer<typeof granularitySchema>;

export const visibilitySchema = z.enum(["staff_only", "guardian", "student", "public"]);
export type Visibility = z.infer<typeof visibilitySchema>;

/** An axis whose entries live in the platform's shared masters. */
export const platformAxisSchema = z.enum(["grade", "class", "special_needs_class"]);
export type PlatformAxis = z.infer<typeof platformAxisSchema>;

export const targetGroupInputSchema = z.object({
  id: nonEmptyString,
  key: nonEmptyString,
  name: nonEmptyString,
  sort: z.number().int().optional(),
});
export type TargetGroupInput = z.infer<typeof targetGroupInputSchema>;

export const targetInputSchema = z.object({
  id: nonEmptyString,
  targetGroupId: nonEmptyString,
  code: nonEmptyString.nullable().optional(),
  name: nonEmptyString,
  sort: z.number().int().optional(),
  parentTargetId: nonEmptyString.nullable().optional(),
});
export type TargetInput = z.infer<typeof targetInputSchema>;

export const itemOptionInputSchema = z.object({
  id: nonEmptyString,
  code: nonEmptyString,
  label: nonEmptyString,
  meaning: z.string().nullable().optional(),
  colorHint: z.string().nullable().optional(),
  countsAs: z.record(z.string(), z.unknown()).nullable().optional(),
  sort: z.number().int().optional(),
});
export type ItemOptionInput = z.infer<typeof itemOptionInputSchema>;

export const itemDefinitionInputSchema = z
  .object({
    id: nonEmptyString,
    key: nonEmptyString,
    name: nonEmptyString,
    valueType: valueTypeSchema,
    targetGroupId: nonEmptyString.nullable().optional(),
    targetPlatformAxis: platformAxisSchema.nullable().optional(),
    granularity: granularitySchema,
    defaultVisibility: visibilitySchema,
    isAggregatable: z.boolean().optional(),
    sort: z.number().int().optional(),
    isActive: z.boolean().optional(),
    options: z.array(itemOptionInputSchema).optional(),
  })
  .refine((v) => !(v.targetGroupId && v.targetPlatformAxis), {
    message: "an item varies over a platform axis or an app target group, not both",
  });
export type ItemDefinitionInput = z.infer<typeof itemDefinitionInputSchema>;

export const locationInputSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  kind: z.string().nullable().optional(),
  sort: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export const inputOpenerSchema = z.enum(["popover", "modal"]);
export type InputOpener = z.infer<typeof inputOpenerSchema>;

export const saveSettingsInputSchema = z.object({
  inputOpener: inputOpenerSchema,
  /**
   * The absence kinds that count for duty-conflict detection
   * (Issue #31). Optional: leaving it out keeps the stored value;
   * null counts every kind, a list counts only those kinds.
   */
  dutyConflictAbsenceKinds: z.array(absenceKindSchema).nullable().optional(),
});
export type SaveSettingsInput = z.infer<typeof saveSettingsInputSchema>;

export const presetKeySchema = z.enum(["elementary_no_bus", "elementary_bus", "junior_high"]);
export type PresetKey = z.infer<typeof presetKeySchema>;

export const applyPresetInputSchema = z.object({
  preset: presetKeySchema,
});
export type ApplyPresetInput = z.infer<typeof applyPresetInputSchema>;

export const deleteInputSchema = z.object({
  id: nonEmptyString,
});
