/**
 * Shared shapes for talking to the platform (Issue #6,
 * DESIGN-AUTH-TENANCY 4.1). The products are the platform's product
 * enum; roles are per product (4.2).
 */
export type Product = "schedule" | "timetable";

export type Role = "Admin" | "Editor" | "Viewer";

/**
 * What an action layer works against (DESIGN-AUTH-TENANCY 4.1). The
 * platform supplies userId, schoolId, role, isSuperAdmin and teacherId.
 * `personId` is the consuming app's own people-row id, which the
 * platform cannot know: verifyRequest leaves it null and the app
 * resolves it locally when it needs it. The schedule app keeps no
 * people table of its own: whether a record is "one's own" is judged
 * by teacherId, matched against the shared staff master
 * (DESIGN-INTEGRATION 10).
 */
export interface AuthContext {
  /** The platform's person id. */
  userId: string;
  /** The platform's school id (the same value the timetable uses). */
  schoolId: string;
  /** This product's role for the person (4.2). */
  role: Role;
  /** Platform operator (the platform's SuperAdmin), not a school role. */
  isSuperAdmin: boolean;
  /** The consuming app's own people-row id, or null when unresolved. */
  personId: number | null;
  /** The platform's teacher id, for linking with the timetable (7). */
  teacherId: string | null;
}

/** The platform's context endpoint response, before personId mapping. */
export interface PlatformContextResponse {
  userId: string;
  schoolId: string;
  product: Product;
  role: Role;
  isSuperAdmin: boolean;
  teacherId: string | null;
}
