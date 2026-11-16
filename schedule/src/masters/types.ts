import { z } from "zod";

/**
 * Payload shapes for the shared-master relay (Issue #39). The
 * masters themselves live in the platform (DESIGN-INTEGRATION
 * 2.4): staff, grades, classes, special-needs classes and day
 * patterns, each with its own platform schema. The relay names
 * only what it needs to route — the kind, and for an update or
 * delete the record id — and passes the record through as an
 * opaque body, exactly as the event relay passes event payloads
 * (Issue #29): the platform validates the record against its
 * own schema and its verdict (400 / 403 / 409) comes back as-is.
 * The cookie rides as a named field, as in every relay input.
 */
const nonEmptyString = z.string().min(1);

export const masterKindSchema = z.enum([
  "staff",
  "grade",
  "class",
  "special_needs_class",
  "day_pattern",
]);
export type MasterKind = z.infer<typeof masterKindSchema>;

/** The platform path segment of one master kind. */
export const MASTER_SEGMENTS: Record<MasterKind, string> = {
  staff: "staff",
  grade: "grades",
  class: "classes",
  special_needs_class: "special-needs-classes",
  day_pattern: "day-patterns",
};

const revisionSchema = z.number().int().min(1);

export const getMastersInputSchema = z.object({
  cookie: nonEmptyString,
});
export type GetMastersInput = z.infer<typeof getMastersInputSchema>;

export const createMasterInputSchema = z.object({
  cookie: nonEmptyString,
  kind: masterKindSchema,
  /** The record to create, without meta: the platform stamps
   *  the revision and the writer itself. */
  record: z.looseObject({ id: nonEmptyString }),
});
export type CreateMasterInput = z.infer<typeof createMasterInputSchema>;

export const updateMasterInputSchema = z.object({
  cookie: nonEmptyString,
  kind: masterKindSchema,
  id: nonEmptyString,
  /** The whole record as last read, revision included: the
   *  platform's update takes the record back with the revision
   *  the caller last saw (calendar-types' master records). */
  record: z.looseObject({ id: nonEmptyString, revision: revisionSchema }),
});
export type UpdateMasterInput = z.infer<typeof updateMasterInputSchema>;

export const deleteMasterInputSchema = z.object({
  cookie: nonEmptyString,
  kind: masterKindSchema,
  id: nonEmptyString,
  revision: revisionSchema,
});
export type DeleteMasterInput = z.infer<typeof deleteMasterInputSchema>;
