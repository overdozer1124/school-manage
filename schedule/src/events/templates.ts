import { z } from "zod";
import type { KindTemplateInput } from "./types.js";

/**
 * The kind templates' shared shapes and shipped defaults (Issue
 * #29; DESIGN schedule 6.3.1 and 6.5).
 *
 * A quick-entry step is one of the built-in steps — the person, the
 * location, the time band, the leave subdivision — or one of the
 * kind's own items ("item"). An item step names its item definition
 * once the school has bound one; the deadline default leaves it
 * unbound on purpose: its item is the school's own
 * submission-destination definition, which the shipped defaults
 * cannot know.
 */
export const kindTemplateStepKindSchema = z.enum([
  "person",
  "location",
  "time",
  "subdivision",
  "item",
]);
export type KindTemplateStepKind = z.infer<typeof kindTemplateStepKindSchema>;

export const kindTemplateStepSchema = z.object({
  kind: kindTemplateStepKindSchema,
  itemDefinitionId: z.string().min(1).nullable().optional(),
});
export type KindTemplateStepInput = z.infer<typeof kindTemplateStepSchema>;

/**
 * The four templates every school starts from (Issue #29): 行事／
 * 出張／〆切／休暇. subjectKind records where the platform stores
 * entries of the kind — business trips and leave are platform
 * absences, not events (DESIGN-INTEGRATION 2.2 / 2.3), and the
 * template says so.
 *
 * The step orders follow DESIGN schedule 6.5: the person first,
 * then the kind's own step in place of the location where the kind
 * has one （休暇 has no location step and takes the subdivision
 * step instead; 〆切 takes its submission-destination item), then
 * the time. The display lead follows 6.3.1: the title for events
 * and deadlines, the person for leave （取得者名（分類）), person and
 * title together for business trips.
 */
export const DEFAULT_KIND_TEMPLATES: readonly KindTemplateInput[] = [
  {
    id: "tpl-event",
    key: "event",
    name: "行事",
    subjectKind: "event",
    kindCode: "event",
    personLabel: "担当者",
    displaySource: "title",
    steps: [{ kind: "person" }, { kind: "location" }, { kind: "time" }],
    itemDefinitionIds: [],
    sort: 1,
  },
  {
    id: "tpl-business-trip",
    key: "business_trip",
    name: "出張",
    subjectKind: "absence",
    kindCode: "business_trip",
    personLabel: "出張者",
    displaySource: "person_title",
    steps: [{ kind: "person" }, { kind: "location" }, { kind: "time" }],
    itemDefinitionIds: [],
    sort: 2,
  },
  {
    id: "tpl-deadline",
    key: "deadline",
    name: "〆切",
    subjectKind: "event",
    kindCode: "deadline",
    personLabel: "担当者",
    displaySource: "title",
    steps: [{ kind: "person" }, { kind: "item", itemDefinitionId: null }, { kind: "time" }],
    itemDefinitionIds: [],
    sort: 3,
  },
  {
    id: "tpl-leave",
    key: "leave",
    name: "休暇",
    subjectKind: "absence",
    kindCode: "leave",
    personLabel: "取得者",
    displaySource: "person",
    steps: [{ kind: "person" }, { kind: "subdivision" }, { kind: "time" }],
    itemDefinitionIds: [],
    sort: 4,
  },
];
