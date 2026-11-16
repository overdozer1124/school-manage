import { createDailyValueActions } from "./dailyValues/actions.js";
import { createDutyActions } from "./duties/actions.js";
import { createHttpDutyPlatformSource } from "./duties/platformSource.js";
import { createEventActions } from "./events/actions.js";
import type { PlatformApiClient } from "./platformClient.js";
import { createRangeActions } from "./range/actions.js";

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
  };
}
