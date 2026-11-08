import { z } from "zod";
import { nonEmptyString } from "./codes.js";

/**
 * A reference to "which target on which axis" (DESIGN-INTEGRATION 8-1-3).
 * Targets on the shared-master axes affect the timetable. Targets on an
 * app-specific axis (clubs, bus routes, committees in the schedule app)
 * are carried along but ignored by the timetable.
 */
export const targetRefSchema = z.discriminatedUnion("axis", [
  z.object({
    axis: z.enum(["grade", "class", "special_needs_class", "staff", "room"]),
    id: nonEmptyString,
  }),
  z.object({
    axis: z.literal("app"),
    app: z.literal("schedule"),
    axisKey: nonEmptyString,
    id: nonEmptyString,
  }),
]);
export type TargetRef = z.infer<typeof targetRefSchema>;

/** The derived form the timetable consumes: which periods of a date are
 *  affected, for which targets (DESIGN-INTEGRATION 7.1 / 8.1). */
export const derivedImpactSchema = z.object({
  date: z.string(),
  periods: z.array(z.number().int().min(1)),
  targets: z.array(targetRefSchema),
});
export type DerivedImpact = z.infer<typeof derivedImpactSchema>;
