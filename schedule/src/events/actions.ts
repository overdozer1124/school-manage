import { defineActions } from "@school-manage/platform-client";
import type { ValueType } from "../definitions/types.js";
import * as valuesStore from "../db/eventValues.js";
import * as templatesStore from "../db/kindTemplates.js";
import { itemDefinitions } from "../db/schema.js";
import { assertOwned, tenantDb } from "../db/tenant.js";
import { platformAction, scheduleAction } from "../permissions.js";
import { unwrapPlatformResult, type PlatformApiClient } from "../platformClient.js";
import { createTargetResolver, loadItemWithOptions } from "../dailyValues/target.js";
import { validateDailyValue } from "../dailyValues/value.js";
import {
  confirmAbsenceInputSchema,
  createAbsenceInputSchema,
  createEventInputSchema,
  deleteAbsenceInputSchema,
  deleteEventInputSchema,
  deleteKindTemplateInputSchema,
  getEventValuesInputSchema,
  kindTemplateInputSchema,
  moveAbsenceInputSchema,
  moveEventInputSchema,
  pendingAbsencesInputSchema,
  setEventValuesInputSchema,
  updateAbsenceInputSchema,
  updateEventInputSchema,
  type EventValueInput,
  type SubjectKind,
} from "./types.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

const EVENTS_PATH = "/platform/api/v1/calendar/events";
const ABSENCES_PATH = "/platform/api/v1/calendar/absences";

/**
 * The platform record was saved but its additional items were not
 * (DESIGN-INTEGRATION 10, the two-database save order). The body is
 * deliberately kept — a record with a title and dates stands on its
 * own — and this error is how the caller tells the two apart: it
 * carries the saved platform record and the subject the values
 * belong to, so the caller can retry just the values through
 * setEventValues. Anything else that fails while saving values is
 * the `cause`.
 */
export class EventValuesSaveError extends Error {
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly record: unknown;

  constructor(subjectKind: SubjectKind, subjectId: string, record: unknown, cause: unknown) {
    super(
      `the platform ${subjectKind} was saved, but its additional items were not: ${subjectId}`,
      { cause },
    );
    this.name = "EventValuesSaveError";
    this.subjectKind = subjectKind;
    this.subjectId = subjectId;
    this.record = record;
  }
}

/**
 * The event relay, event-value and kind-template actions (Issue
 * #29).
 *
 * Events and absences themselves live in the platform
 * (DESIGN-INTEGRATION 10, implementation 1): create / update /
 * delete / move and the confirmation flow are relayed with the
 * user's cookie, and the platform's verdict — 401, 403, 409 — comes
 * back as-is (a PlatformRelayError), so these actions are declared
 * with platformAction, not with schedule's own permission table
 * (see permissions.ts for why a schedule-side role check would be
 * wrong here). Their additional items (event_values) live in this
 * database and are saved after the platform save succeeds; the kind
 * templates are this database's own definitions, so they use the
 * ordinary scheduleAction permissions (view.read to read,
 * definition.write to change, per the Issue).
 */
export function createEventActions(db: Db, platformClient: PlatformApiClient) {
  const resolver = createTargetResolver(db);

  /**
   * Validates every value against its item definition (existence,
   * target fit, the pure value validator) and only then replaces
   * the subject's stored set, so a bad entry late in the list
   * leaves the previous values untouched.
   */
  async function saveValues(
    auth: { schoolId: string; userId: string },
    subjectKind: SubjectKind,
    subjectId: string,
    values: readonly EventValueInput[],
  ) {
    const entries: valuesStore.EventValueEntry[] = [];
    for (const value of values) {
      const { item, options } = await loadItemWithOptions(
        db,
        auth.schoolId,
        value.itemDefinitionId,
      );
      const resolved = await resolver.resolveOptionalTarget(auth.schoolId, item, value.target);
      const columns = validateDailyValue(item.valueType as ValueType, options, value.value);
      entries.push({ itemDefinitionId: item.id, ...resolved, columns });
    }
    return valuesStore.replaceEventValues(
      db,
      auth.schoolId,
      subjectKind,
      subjectId,
      entries,
      auth.userId,
    );
  }

  /** Saves a create / update's values, translating a failure into
   *  the "body saved, values not" signal the design prescribes. */
  async function saveValuesAfterPlatformSave(
    auth: { schoolId: string; userId: string },
    subjectKind: SubjectKind,
    subjectId: string,
    values: readonly EventValueInput[],
    record: unknown,
  ) {
    try {
      return await saveValues(auth, subjectKind, subjectId, values);
    } catch (cause) {
      throw new EventValuesSaveError(subjectKind, subjectId, record, cause);
    }
  }

  async function relay(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    cookie: string,
    body?: unknown,
  ): Promise<unknown> {
    return unwrapPlatformResult(await platformClient.requestJson(method, path, cookie, body));
  }

  /** Reads the current platform record a move starts from. */
  async function readRecord(path: string, cookie: string): Promise<Record<string, unknown>> {
    const record = await relay("GET", path, cookie);
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`platform returned an unexpected record for ${path}`);
    }
    return record as Record<string, unknown>;
  }

  /** The platform path of one subject record. */
  function subjectPath(subjectKind: SubjectKind, subjectId: string): string {
    const base = subjectKind === "event" ? EVENTS_PATH : ABSENCES_PATH;
    return `${base}/${encodeURIComponent(subjectId)}`;
  }

  return defineActions({
    // --- Events (platform records, relayed) ------------------------

    createEvent: platformAction("event.write", async ({ auth, request }) => {
      const input = createEventInputSchema.parse(request);
      const record = await relay("POST", EVENTS_PATH, input.cookie, input.event);
      const values = input.values
        ? await saveValuesAfterPlatformSave(auth, "event", input.event.id, input.values, record)
        : [];
      return { record, values };
    }),

    updateEvent: platformAction("event.write", async ({ auth, request }) => {
      const input = updateEventInputSchema.parse(request);
      const body = { ...input.event, id: input.id, revision: input.revision };
      const record = await relay(
        "PUT",
        `${EVENTS_PATH}/${encodeURIComponent(input.id)}`,
        input.cookie,
        body,
      );
      const values = input.values
        ? await saveValuesAfterPlatformSave(auth, "event", input.id, input.values, record)
        : null;
      return { record, values };
    }),

    deleteEvent: platformAction("event.write", async ({ auth, request }) => {
      const input = deleteEventInputSchema.parse(request);
      await relay("DELETE", `${EVENTS_PATH}/${encodeURIComponent(input.id)}`, input.cookie, {
        revision: input.revision,
      });
      // The body is gone, so its additional items go too (Issue #29).
      await valuesStore.deleteEventValues(db, auth.schoolId, "event", input.id);
      return { deleted: true };
    }),

    moveEvent: platformAction("event.write", async ({ request }) => {
      const input = moveEventInputSchema.parse(request);
      const path = `${EVENTS_PATH}/${encodeURIComponent(input.id)}`;
      const current = await readRecord(path, input.cookie);
      // A move is an update of the dates only: the platform takes
      // the whole record, so the current one is read back and its
      // dates replaced. The record's own fields (certainty
      // included) ride along untouched; a change since the caller's
      // revision surfaces as the platform's 409, as-is.
      return relay("PUT", path, input.cookie, {
        ...current,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        revision: input.revision,
      });
    }),

    // --- Absences (platform records, relayed) ----------------------

    createAbsence: platformAction("event.write", async ({ auth, request }) => {
      const input = createAbsenceInputSchema.parse(request);
      const record = await relay("POST", ABSENCES_PATH, input.cookie, input.absence);
      const values = input.values
        ? await saveValuesAfterPlatformSave(auth, "absence", input.absence.id, input.values, record)
        : [];
      return { record, values };
    }),

    updateAbsence: platformAction("event.write", async ({ auth, request }) => {
      const input = updateAbsenceInputSchema.parse(request);
      const body = { ...input.absence, id: input.id, revision: input.revision };
      const record = await relay(
        "PUT",
        `${ABSENCES_PATH}/${encodeURIComponent(input.id)}`,
        input.cookie,
        body,
      );
      const values = input.values
        ? await saveValuesAfterPlatformSave(auth, "absence", input.id, input.values, record)
        : null;
      return { record, values };
    }),

    deleteAbsence: platformAction("event.write", async ({ auth, request }) => {
      const input = deleteAbsenceInputSchema.parse(request);
      await relay("DELETE", `${ABSENCES_PATH}/${encodeURIComponent(input.id)}`, input.cookie, {
        revision: input.revision,
      });
      await valuesStore.deleteEventValues(db, auth.schoolId, "absence", input.id);
      return { deleted: true };
    }),

    moveAbsence: platformAction("event.write", async ({ request }) => {
      const input = moveAbsenceInputSchema.parse(request);
      const path = `${ABSENCES_PATH}/${encodeURIComponent(input.id)}`;
      const current = await readRecord(path, input.cookie);
      return relay("PUT", path, input.cookie, {
        ...current,
        fromDate: input.fromDate,
        toDate: input.toDate,
        revision: input.revision,
      });
    }),

    getPendingAbsences: platformAction("event.confirm", async ({ request }) => {
      const input = pendingAbsencesInputSchema.parse(request);
      return relay("GET", `${ABSENCES_PATH}/pending`, input.cookie);
    }),

    confirmAbsence: platformAction("event.confirm", async ({ request }) => {
      const input = confirmAbsenceInputSchema.parse(request);
      return relay(
        "POST",
        `${ABSENCES_PATH}/${encodeURIComponent(input.id)}/confirm`,
        input.cookie,
        { revision: input.revision },
      );
    }),

    // --- Additional items (this database) --------------------------

    /**
     * A subject's additional items, gated by the platform record
     * itself: the values are served only when the platform shows
     * this caller the record (Issue #29 review). A record the
     * platform will not hand over — gone, another school's, or not
     * for this caller — answers with the empty set, as an unknown
     * subject always did. For an absence there is one more gate:
     * the platform hands a reader who may not see the private texts
     * a restricted shape with no purpose field (the leave privacy
     * rule, PR #64), and that reader does not get the values
     * either. The judgment stays the platform's — this layer holds
     * no second copy of it, it only looks at the shape it was
     * handed.
     */
    getEventValues: scheduleAction("view.read", async ({ auth, request }) => {
      const input = getEventValuesInputSchema.parse(request);
      const shown = await platformClient.getJson(
        subjectPath(input.subjectKind, input.subjectId),
        input.cookie,
      );
      if (shown.status < 200 || shown.status >= 300) return [];
      if (input.subjectKind === "absence") {
        const body = shown.body;
        if (!body || typeof body !== "object" || !("purpose" in body)) return [];
      }
      return valuesStore.getEventValues(db, auth.schoolId, input.subjectKind, input.subjectId);
    }),

    /**
     * The retry half of the two-database save: (re)writes a
     * platform record's additional items without touching the
     * record. Declared with platformAction like the saves it
     * completes — who may set a record's values is who may save the
     * record, and that verdict is the platform's （連携5). Unlike
     * the saves it completes, this action's own work never reaches
     * the platform, so the verdict is asked for explicitly first:
     * the platform's write-check runs the very guard a save would
     * run, and its answer — 401, 403, a 404 for a subject that is
     * not there — comes back as-is and nothing is written.
     */
    setEventValues: platformAction("event.write", async ({ auth, request }) => {
      const input = setEventValuesInputSchema.parse(request);
      await relay(
        "GET",
        `${subjectPath(input.subjectKind, input.subjectId)}/write-check`,
        input.cookie,
      );
      return saveValues(auth, input.subjectKind, input.subjectId, input.values);
    }),

    // --- Kind templates (this database) ----------------------------

    getKindTemplates: scheduleAction("view.read", async ({ auth }) =>
      templatesStore.getKindTemplates(db, auth.schoolId),
    ),

    upsertKindTemplate: scheduleAction("definition.write", async ({ auth, request }) => {
      const input = kindTemplateInputSchema.parse(request);
      const referenced = [
        ...(input.itemDefinitionIds ?? []),
        ...input.steps.map((s) => s.itemDefinitionId).filter((id): id is string => id != null),
      ];
      if (referenced.length > 0) {
        await assertOwned(tenantDb(db, auth.schoolId), itemDefinitions, referenced);
      }
      return templatesStore.upsertKindTemplate(db, auth.schoolId, input);
    }),

    deleteKindTemplate: scheduleAction("definition.write", async ({ auth, request }) => {
      const { id } = deleteKindTemplateInputSchema.parse(request);
      if (!(await templatesStore.deleteKindTemplate(db, auth.schoolId, id))) {
        throw new Error(`kind template not found: ${id}`);
      }
      return { deleted: true };
    }),

    applyDefaultKindTemplates: scheduleAction("definition.write", async ({ auth }) =>
      templatesStore.applyDefaultKindTemplates(db, auth.schoolId),
    ),
  });
}
