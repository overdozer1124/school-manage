import { absenceKindSchema } from "@school-manage/calendar-types";
import { z } from "zod";

/**
 * Payload shapes for the absence-subdivision relay (Issue #84).
 * The subdivision definitions themselves live in the platform
 * (Issue #25): under a fixed absence kind (code), the school's
 * own key and label. Unlike the shared masters (Issue #39), whose
 * records pass through opaquely, a subdivision record is small
 * and fully named here — the platform's input schema
 * (absenceSubdivisionInputSchema) is exactly { id, code, key,
 * label, sort? } plus the revision an update or delete carries
 * — so the relay validates the shape it forwards instead of
 * passing an arbitrary body at an endpoint whose contract it
 * knows. The cookie rides as a named field, as in every relay
 * input.
 */
const nonEmptyString = z.string().min(1);
const revisionSchema = z.number().int().min(1);

export const getSubdivisionsInputSchema = z.object({
  cookie: nonEmptyString,
});
export type GetSubdivisionsInput = z.infer<typeof getSubdivisionsInputSchema>;

/** A subdivision record without its meta: what a create sends,
 *  and what an update sends back with the revision added. The
 *  sort is the school's display order within the kind (Issue
 *  #91); it stays optional here exactly as in the platform's
 *  input — a create without one is appended after its kind, an
 *  update without one keeps the stored order. */
const subdivisionRecordShape = {
  id: nonEmptyString,
  code: absenceKindSchema,
  key: nonEmptyString,
  label: nonEmptyString,
  sort: z.number().int().min(0).optional(),
};

export const createSubdivisionInputSchema = z.object({
  cookie: nonEmptyString,
  record: z.object(subdivisionRecordShape),
});
export type CreateSubdivisionInput = z.infer<typeof createSubdivisionInputSchema>;

export const updateSubdivisionInputSchema = z.object({
  cookie: nonEmptyString,
  id: nonEmptyString,
  record: z.object({ ...subdivisionRecordShape, revision: revisionSchema }),
});
export type UpdateSubdivisionInput = z.infer<typeof updateSubdivisionInputSchema>;

export const deleteSubdivisionInputSchema = z.object({
  cookie: nonEmptyString,
  id: nonEmptyString,
  revision: revisionSchema,
});
export type DeleteSubdivisionInput = z.infer<typeof deleteSubdivisionInputSchema>;

export const applyDefaultSubdivisionsInputSchema = z.object({
  cookie: nonEmptyString,
});
export type ApplyDefaultSubdivisionsInput = z.infer<typeof applyDefaultSubdivisionsInputSchema>;
