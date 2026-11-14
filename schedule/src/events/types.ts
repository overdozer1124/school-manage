import { z } from "zod";
import {
  absenceKindSchema,
  dateStringSchema,
  eventKindSchema,
  targetRefSchema,
} from "@school-manage/calendar-types";
import { kindTemplateStepSchema } from "./templates.js";

/**
 * Payload shapes for the event relay, event-value and kind-template
 * actions (Issue #29).
 *
 * The platform payloads (event / absence) are deliberately opaque
 * records here: the platform owns their shape and their validation,
 * and a relay that re-validated them would fork both (its verdicts
 * come back as-is, 400 included). What the schedule layer itself
 * needs it does name: the record id (the values are keyed by it),
 * the revision (the platform's optimistic lock travels in the body),
 * and the move dates. The cookie is a named field for the same
 * reason: implementation 1 has this server call the platform with
 * the user's cookie forwarded as-is, and the caller of the action
 * (the screens' HTTP layer, a later issue) hands it over per call —
 * it is never stored.
 */
const nonEmptyString = z.string().min(1);

export const subjectKindSchema = z.enum(["event", "absence"]);
export type SubjectKind = z.infer<typeof subjectKindSchema>;

/** One additional item value to store with a platform record. The
 *  value itself is `unknown`: its shape follows the item
 *  definition's value type and is checked by the pure validator
 *  when the values are saved (as with the daily values, Issue #28). */
export const eventValueInputSchema = z.object({
  itemDefinitionId: nonEmptyString,
  target: targetRefSchema.nullable().optional(),
  value: z.unknown(),
});
export type EventValueInput = z.infer<typeof eventValueInputSchema>;

/** A platform payload, passed through untouched apart from the id
 *  the values are keyed by (a loose object: unknown fields are the
 *  platform's business and travel as-is). */
const platformRecordSchema = z.looseObject({ id: nonEmptyString });

const revisionSchema = z.number().int().min(1);

export const createEventInputSchema = z.object({
  cookie: nonEmptyString,
  event: platformRecordSchema,
  values: z.array(eventValueInputSchema).optional(),
});
export type CreateEventInput = z.infer<typeof createEventInputSchema>;

export const updateEventInputSchema = z.object({
  cookie: nonEmptyString,
  id: nonEmptyString,
  revision: revisionSchema,
  event: platformRecordSchema,
  /** When given, replaces the record's values wholesale; when
   *  omitted, the values are left as they are. */
  values: z.array(eventValueInputSchema).optional(),
});
export type UpdateEventInput = z.infer<typeof updateEventInputSchema>;

export const deleteEventInputSchema = z.object({
  cookie: nonEmptyString,
  id: nonEmptyString,
  revision: revisionSchema,
});
export type DeleteEventInput = z.infer<typeof deleteEventInputSchema>;

export const moveEventInputSchema = z.object({
  cookie: nonEmptyString,
  id: nonEmptyString,
  revision: revisionSchema,
  startsOn: dateStringSchema.nullable(),
  endsOn: dateStringSchema.nullable(),
});
export type MoveEventInput = z.infer<typeof moveEventInputSchema>;

export const createAbsenceInputSchema = z.object({
  cookie: nonEmptyString,
  absence: platformRecordSchema,
  values: z.array(eventValueInputSchema).optional(),
});
export type CreateAbsenceInput = z.infer<typeof createAbsenceInputSchema>;

export const updateAbsenceInputSchema = z.object({
  cookie: nonEmptyString,
  id: nonEmptyString,
  revision: revisionSchema,
  absence: platformRecordSchema,
  values: z.array(eventValueInputSchema).optional(),
});
export type UpdateAbsenceInput = z.infer<typeof updateAbsenceInputSchema>;

export const deleteAbsenceInputSchema = deleteEventInputSchema;
export type DeleteAbsenceInput = z.infer<typeof deleteAbsenceInputSchema>;

export const moveAbsenceInputSchema = z.object({
  cookie: nonEmptyString,
  id: nonEmptyString,
  revision: revisionSchema,
  fromDate: dateStringSchema,
  toDate: dateStringSchema,
});
export type MoveAbsenceInput = z.infer<typeof moveAbsenceInputSchema>;

export const confirmAbsenceInputSchema = z.object({
  cookie: nonEmptyString,
  id: nonEmptyString,
  revision: revisionSchema,
});
export type ConfirmAbsenceInput = z.infer<typeof confirmAbsenceInputSchema>;

export const pendingAbsencesInputSchema = z.object({
  cookie: nonEmptyString,
});
export type PendingAbsencesInput = z.infer<typeof pendingAbsencesInputSchema>;

export const setEventValuesInputSchema = z.object({
  /** The caller's platform cookie: saving values alone asks the
   *  platform's write-check first (Issue #29 review), like every
   *  other relay input. */
  cookie: nonEmptyString,
  subjectKind: subjectKindSchema,
  subjectId: nonEmptyString,
  values: z.array(eventValueInputSchema),
});
export type SetEventValuesInput = z.infer<typeof setEventValuesInputSchema>;

export const getEventValuesInputSchema = z.object({
  /** The caller's platform cookie: a subject's values are read only
   *  after the platform shows that caller the record itself. */
  cookie: nonEmptyString,
  subjectKind: subjectKindSchema,
  subjectId: nonEmptyString,
});
export type GetEventValuesInput = z.infer<typeof getEventValuesInputSchema>;

/**
 * A kind template as a school saves it (DESIGN schedule 6.3.1 /
 * 6.5). kindCode must be a kind code of the template's subject —
 * an event kind for an event template, an absence kind for an
 * absence one; the shared code lists live in
 * @school-manage/calendar-types, and the database holds the same
 * rule as a check constraint.
 */
export const kindTemplateInputSchema = z
  .object({
    id: nonEmptyString,
    key: nonEmptyString,
    name: nonEmptyString,
    subjectKind: subjectKindSchema,
    kindCode: nonEmptyString,
    personLabel: nonEmptyString,
    displaySource: z.enum(["title", "person", "person_title"]),
    steps: z.array(kindTemplateStepSchema),
    itemDefinitionIds: z.array(nonEmptyString).optional(),
    sort: z.number().int().optional(),
  })
  .superRefine((v, ctx) => {
    const codes = v.subjectKind === "event" ? eventKindSchema.options : absenceKindSchema.options;
    if (!(codes as readonly string[]).includes(v.kindCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `kindCode "${v.kindCode}" is not a ${v.subjectKind} kind code`,
        path: ["kindCode"],
      });
    }
  });
export type KindTemplateInput = z.infer<typeof kindTemplateInputSchema>;

export const deleteKindTemplateInputSchema = z.object({
  id: nonEmptyString,
});
