import { z } from "zod";
import { dateStringSchema, targetRefSchema } from "@school-manage/calendar-types";

/**
 * Payload shapes for the daily-value actions (Issue #28). The value
 * itself is deliberately `unknown` here: its shape depends on the
 * item definition's value type, and checking it is the job of the
 * pure validator in value.ts, which has the definition (and its
 * options) at hand. Dates and slots have fixed shapes and are
 * checked here; a slot is "all_day" / "am" / "pm" or a period
 * number (DESIGN schedule 4.6).
 */
const nonEmptyString = z.string().min(1);

export const slotInputSchema = z.union([
  z.enum(["all_day", "am", "pm"]),
  z.number().int().min(0).max(99),
]);
export type SlotInput = z.infer<typeof slotInputSchema>;

export const getDailyValuesInputSchema = z
  .object({
    from: dateStringSchema,
    to: dateStringSchema,
    itemDefinitionId: nonEmptyString.optional(),
  })
  .refine((v) => v.from <= v.to, { message: "from must be on or before to" });
export type GetDailyValuesInput = z.infer<typeof getDailyValuesInputSchema>;

export const setDailyValueInputSchema = z.object({
  date: dateStringSchema,
  itemDefinitionId: nonEmptyString,
  target: targetRefSchema.nullable().optional(),
  slot: slotInputSchema.optional(),
  value: z.unknown(),
});
export type SetDailyValueInput = z.infer<typeof setDailyValueInputSchema>;

export const setDailyValuesForTargetsInputSchema = z.object({
  date: dateStringSchema,
  itemDefinitionId: nonEmptyString,
  targets: z.array(targetRefSchema).min(1),
  slot: slotInputSchema.optional(),
  value: z.unknown(),
});
export type SetDailyValuesForTargetsInput = z.infer<typeof setDailyValuesForTargetsInputSchema>;

export const deleteDailyValueInputSchema = z.object({
  date: dateStringSchema,
  itemDefinitionId: nonEmptyString,
  target: targetRefSchema.nullable().optional(),
  slot: slotInputSchema.optional(),
});
export type DeleteDailyValueInput = z.infer<typeof deleteDailyValueInputSchema>;
