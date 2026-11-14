import {
  secureAction,
  type AuthContext,
  type PermissionTable,
  type SecureAction,
} from "@school-manage/platform-client";

/**
 * Schedule's permission table (DESIGN-AUTH-TENANCY 4.4, rebuilt for
 * this implementation per the 2026-11-09 note in that section). It
 * guards only the data in schedule's own database. Events, days,
 * absences and the shared masters are read and written through the
 * platform, which checks its own permissions (DESIGN-INTEGRATION 10,
 * implementation 1), so their permissions are not listed here.
 *
 * A permission name is a key of this table (Issue #26): declaring any
 * other name in an action is a compile error. Where 4.4 marks a role
 * △ (duty.write for Viewer), the role may call the action and the
 * restriction (own assignments only) is enforced per row inside the
 * handler, with a pure function, as 4.3 prescribes.
 */
export const schedulePermissions = {
  "view.read": ["Admin", "Editor", "Viewer"],
  "daily.write": ["Admin", "Editor"],
  "duty.write": ["Admin", "Editor", "Viewer"],
  publish: ["Admin", "Editor"],
  "view.layout": ["Admin", "Editor"],
  // Locations are schedule's own master (DESIGN schedule 4.5.1), so
  // 4.4's master.write applies to them here from Issue #27 on. The
  // shared masters (staff, holidays) stay platform-side.
  "master.write": ["Admin", "Editor"],
  "definition.write": ["Admin"],
  "school.admin": ["Admin"],
} as const satisfies PermissionTable;

/** A schedule permission name: a key of the table above. */
export type SchedulePermission = keyof typeof schedulePermissions;

/**
 * Declares a schedule action: secureAction with this product's table
 * filled in, so call sites name only their permission and handler.
 */
export function scheduleAction<Req, Res>(
  permission: SchedulePermission,
  handler: (ctx: { auth: AuthContext; request: Req }) => Promise<Res> | Res,
): SecureAction<Req, Res> {
  return secureAction({ permission, permissions: schedulePermissions, handler });
}

/**
 * Declares an action whose data lives in the platform (events and
 * absences, DESIGN-INTEGRATION 10 implementation 1; Issue #29). The
 * handler relays the call to the platform with the user's cookie,
 * and the platform performs the permission check: the name recorded
 * here is the DESIGN-AUTH-TENANCY 4.4 permission for the operation
 * ("event.write" / "event.confirm"), kept for the registry, and it
 * is deliberately NOT a key of schedulePermissions and NOT checked
 * against schedule's own role. Checking it here would be wrong, not
 * just redundant: the write rule is Editor-or-more in *either*
 * product （連携5), and this server only knows the caller's schedule
 * role — a timetable Editor with a schedule Viewer role must still
 * be able to save. The platform's verdict (401 / 403 / 409) is
 * returned to the caller as-is instead. What the caller must have is
 * an AuthContext, which verifyRequest has already established
 * (signed in, a current membership, a live entitlement — 4.3 steps
 * 1-2) before any action runs.
 */
export function platformAction<Req, Res>(
  permission: string,
  handler: (ctx: { auth: AuthContext; request: Req }) => Promise<Res> | Res,
): SecureAction<Req, Res> {
  return {
    kind: "secure",
    permission,
    async run(auth, request) {
      return handler({ auth, request });
    },
  };
}
