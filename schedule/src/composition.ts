import { createHttpDutyPlatformSource } from "./duties/platformSource.js";
import type { PlatformApiClient } from "./platformClient.js";
import { createRangeActions } from "./range/actions.js";

/** The database handle type, taken from createRangeActions so this
 *  module never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof createRangeActions>[0];

/**
 * The production assembly of the read actions (Issue #34): the
 * range actions over the real platform client, with the duty
 * platform source reading through that same client under the
 * caller's cookie. The entry point (index.ts) builds the per-request
 * actions through here, and the wiring test builds them the same
 * way, so the paths the duty source asks for are the paths the
 * server actually uses.
 */
export function createScheduleActions(db: Db, platformClient: PlatformApiClient, cookie: string) {
  return createRangeActions(
    db,
    platformClient,
    createHttpDutyPlatformSource(platformClient, cookie),
  );
}
