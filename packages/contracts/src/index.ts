import { z } from "zod";
import { PlatformCapabilitySchema } from "./capabilities.js";

export const RoleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const OrganizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  createdAt: z.string().datetime(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  email: z.string().email(),
  role: RoleSchema,
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const AuditEventSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  actorUserId: z.string().uuid().nullable(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuthRegisterRequestSchema = z.object({
  orgName: z.string().min(1).max(255),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});
export type AuthRegisterRequest = z.infer<typeof AuthRegisterRequestSchema>;

export const AuthLoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});
export type AuthLoginRequest = z.infer<typeof AuthLoginRequestSchema>;

export const AuthSessionSchema = z.object({
  token: z.string().min(32),
  expiresAt: z.string().datetime(),
  user: UserSchema,
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export { PlatformCapabilitySchema } from "./capabilities.js";
export type { PlatformCapability } from "./capabilities.js";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const PROVIDER_CAPABILITY_MATRIX_SCHEMA_VERSION = "1";

export const ProviderCapabilityMatrixSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CAPABILITY_MATRIX_SCHEMA_VERSION),
  providerId: z.string().min(1),
  capabilities: z.array(PlatformCapabilitySchema),
  lastVerifiedAt: z.string().datetime(),
});
export type ProviderCapabilityMatrix = z.infer<typeof ProviderCapabilityMatrixSchema>;

export * from "./affiliate.js";
