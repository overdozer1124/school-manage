/**
 * An authorization verdict, kept apart the way DESIGN-AUTH-TENANCY 4.8
 * requires: 401 means "not logged in" (send the person to the
 * platform's login), 403 means "logged in but not entitled" (show "no
 * permission"). Anything else (the platform being unreachable, a 5xx)
 * is not a verdict and surfaces as a plain Error instead.
 */
export class AuthAccessError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthAccessError";
    this.status = status;
  }
}
