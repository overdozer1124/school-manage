export { AuthAccessError } from "./errors.js";
export {
  defineActions,
  publicAction,
  secureAction,
  type AnyAction,
  type Permission,
  type PermissionTable,
  type PublicAction,
  type SecureAction,
  type SecureActionDefinition,
} from "./secureAction.js";
export type { AuthContext, PlatformContextResponse, Product, Role } from "./types.js";
export {
  createPlatformClient,
  SESSION_COOKIE,
  type PlatformClient,
  type PlatformClientOptions,
  type RequestLike,
} from "./verify.js";
export {
  createWebhookSignature,
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type WebhookVerificationInput,
} from "./webhook.js";
