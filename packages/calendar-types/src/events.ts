import { z } from "zod";
import { nonEmptyString, productSchema } from "./codes.js";

/** Entity kinds a change event can be about. */
export const changeEntityKindSchema = z.enum([
  "day",
  "holiday",
  "event",
  "absence",
  "absence_subdivision",
  "staff",
  "grade",
  "class",
  "special_needs_class",
  "day_pattern",
]);
export type ChangeEntityKind = z.infer<typeof changeEntityKindSchema>;

/**
 * A change event (DESIGN-INTEGRATION 7.1). `seq` is a platform-wide
 * sequence number; receivers drop duplicates by (school_id, entity_id,
 * revision) and refetch from `seq` when they find a gap.
 */
export const changeEventSchema = z.object({
  seq: z.number().int().min(1),
  schoolId: nonEmptyString,
  kind: changeEntityKindSchema,
  entityId: nonEmptyString,
  revision: z.number().int().min(1),
  op: z.enum(["upsert", "delete"]),
  occurredAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "expected an ISO 8601 timestamp" }),
  actor: z.object({
    userId: nonEmptyString,
    via: productSchema,
  }),
});
export type ChangeEvent = z.infer<typeof changeEventSchema>;
