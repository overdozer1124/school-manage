import { z } from "zod";
import { dateStringSchema } from "@school-manage/calendar-types";

/**
 * Payload shapes for the public viewing actions (Issue #41). The
 * admin actions take the view or token id, like the other settings
 * actions. The public actions take the raw token itself: it is the
 * whole credential of the public URL (DESIGN schedule 9 — knowing
 * the URL is not itself a permission, which is why the token can
 * be revoked), and it travels in the request body, never in a path
 * this server logs or a header another layer might echo.
 */
const nonEmptyString = z.string().min(1);

export const createPublicViewTokenInputSchema = z.object({
  viewId: nonEmptyString,
});
export type CreatePublicViewTokenInput = z.infer<typeof createPublicViewTokenInputSchema>;

export const getPublicViewTokensInputSchema = z.object({
  viewId: nonEmptyString.optional(),
});
export type GetPublicViewTokensInput = z.infer<typeof getPublicViewTokensInputSchema>;

export const revokePublicViewTokenInputSchema = z.object({
  id: nonEmptyString,
});
export type RevokePublicViewTokenInput = z.infer<typeof revokePublicViewTokenInputSchema>;

export const getPublicBootstrapInputSchema = z.object({
  token: nonEmptyString,
});
export type GetPublicBootstrapInput = z.infer<typeof getPublicBootstrapInputSchema>;

export const getPublicRangeInputSchema = z
  .object({
    token: nonEmptyString,
    from: dateStringSchema,
    to: dateStringSchema,
  })
  .refine((v) => v.from <= v.to, { message: "from must be on or before to" });
export type GetPublicRangeInput = z.infer<typeof getPublicRangeInputSchema>;
