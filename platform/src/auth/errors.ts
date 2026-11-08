/**
 * An error the HTTP layer can answer directly: a status code plus a
 * message that is safe to show to the person logging in. Ported from the
 * TRPCError usage in school-timetable's auth code (same messages, plain
 * HTTP statuses instead of tRPC codes).
 */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
