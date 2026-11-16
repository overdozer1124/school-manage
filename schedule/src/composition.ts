import { createDailyValueActions } from "./dailyValues/actions.js";
import { createDefinitionActions } from "./definitions/actions.js";
import { createDutyActions } from "./duties/actions.js";
import { createHttpDutyPlatformSource } from "./duties/platformSource.js";
import { createEventActions } from "./events/actions.js";
import { createMasterRelayActions } from "./masters/actions.js";
import type { PlatformApiClient } from "./platformClient.js";
import { createPublicationActions } from "./publications/actions.js";
import { createRangeActions } from "./range/actions.js";
import { createViewActions } from "./views/actions.js";

/** The database handle type, taken from createRangeActions so this
 *  module never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof createRangeActions>[0];

/**
 * The production assembly of the actions (Issue #34): the
 * range actions over the real platform client, with the duty
 * platform source reading through that same client under the
 * caller's cookie, plus the duty actions of Issues #30 / #31
 * (Issue #38) and the cell editors' writes (Issue #35). The entry
 * point (index.ts) builds the per-request actions through here,
 * and the wiring test builds them the same way, so the paths the
 * duty source asks for are the paths the server actually uses.
 *
 * Issue #39 adds the settings screens' actions: the definition
 * actions of Issue #27 and the view actions of Issue #32 (both
 * existed as action layers but were never assembled here), the
 * shared-master relay, and — inside the event actions — the
 * confirmation queue's reads and confirms.
 */
export function createScheduleActions(db: Db, platformClient: PlatformApiClient, cookie: string) {
  const dutyPlatform = createHttpDutyPlatformSource(platformClient, cookie);
  return {
    ...createRangeActions(db, platformClient, dutyPlatform),
    ...createDutyActions(db, dutyPlatform),
    // Issue #35: the cell editors' writes — the event relay (the
    // platform judges; Issue #29) and schedule's own daily values
    // (Issue #28), assembled the same way as the reads so the HTTP
    // layer and the wiring tests exercise one assembly.
    ...createEventActions(db, platformClient),
    ...createDailyValueActions(db),
    // Issue #39: the settings screens and the confirmation queue.
    ...createDefinitionActions(db),
    ...createViewActions(db),
    ...createMasterRelayActions(platformClient),
    // Issue #40: issuing a month table as a versioned document.
    // Publishing renders through computeRange, so it takes the
    // duty platform source like the range actions do.
    ...createPublicationActions(db, platformClient, dutyPlatform),
  };
}
