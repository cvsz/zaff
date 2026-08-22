import { z } from "zod";

export const ActorSchema = z.union([z.string().uuid(), z.literal("system")]);
export type Actor = z.infer<typeof ActorSchema>;

const EnvelopeFields = {
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  actor: ActorSchema,
};

export const ProductDiscoveredSchema = z.object({
  type: z.literal("ProductDiscovered"),
  ...EnvelopeFields,
  productId: z.string().uuid(),
  source: z.string().min(1),
});

export const ProductRankedSchema = z.object({
  type: z.literal("ProductRanked"),
  ...EnvelopeFields,
  productId: z.string().uuid(),
  opportunityScore: z.number().min(0).max(1),
  rank: z.number().int().positive(),
});

export const CampaignCreatedSchema = z.object({
  type: z.literal("CampaignCreated"),
  ...EnvelopeFields,
  campaignId: z.string().uuid(),
  name: z.string().min(1),
  productIds: z.array(z.string().uuid()),
});

export const CreativeRequestedSchema = z.object({
  type: z.literal("CreativeRequested"),
  ...EnvelopeFields,
  creativeId: z.string().uuid(),
  campaignId: z.string().uuid(),
  format: z.enum(["image", "video", "copy"]),
});

export const CreativeGeneratedSchema = z.object({
  type: z.literal("CreativeGenerated"),
  ...EnvelopeFields,
  creativeId: z.string().uuid(),
  assetIds: z.array(z.string().uuid()).min(1),
});

export const CreativeApprovedSchema = z.object({
  type: z.literal("CreativeApproved"),
  ...EnvelopeFields,
  creativeId: z.string().uuid(),
  approverId: z.string().uuid(),
});

export const ContentScheduledSchema = z.object({
  type: z.literal("ContentScheduled"),
  ...EnvelopeFields,
  contentId: z.string().uuid(),
  channel: z.string().min(1),
  scheduledFor: z.string().datetime(),
});

export const ContentPublishedSchema = z.object({
  type: z.literal("ContentPublished"),
  ...EnvelopeFields,
  contentId: z.string().uuid(),
  channel: z.string().min(1),
  platform: z.string().min(1),
});

export const ContentFailedSchema = z.object({
  type: z.literal("ContentFailed"),
  ...EnvelopeFields,
  contentId: z.string().uuid(),
  reason: z.string().min(1),
  attempt: z.number().int().positive(),
});

export const ClickRecordedSchema = z.object({
  type: z.literal("ClickRecorded"),
  ...EnvelopeFields,
  linkId: z.string().uuid(),
  platform: z.string().min(1),
});

export const ConversionRecordedSchema = z.object({
  type: z.literal("ConversionRecorded"),
  ...EnvelopeFields,
  conversionId: z.string().uuid(),
  orderId: z.string().min(1),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const CommissionRecordedSchema = z.object({
  type: z.literal("CommissionRecorded"),
  ...EnvelopeFields,
  commissionId: z.string().uuid(),
  conversionId: z.string().uuid(),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const PerformanceWindowCompletedSchema = z.object({
  type: z.literal("PerformanceWindowCompleted"),
  ...EnvelopeFields,
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  metrics: z.record(z.number()),
});

export const OptimizationRequestedSchema = z.object({
  type: z.literal("OptimizationRequested"),
  ...EnvelopeFields,
  targetType: z.string().min(1),
  targetId: z.string().uuid(),
  reason: z.string().min(1),
});

export const EVENT_SCHEMAS = [
  ProductDiscoveredSchema,
  ProductRankedSchema,
  CampaignCreatedSchema,
  CreativeRequestedSchema,
  CreativeGeneratedSchema,
  CreativeApprovedSchema,
  ContentScheduledSchema,
  ContentPublishedSchema,
  ContentFailedSchema,
  ClickRecordedSchema,
  ConversionRecordedSchema,
  CommissionRecordedSchema,
  PerformanceWindowCompletedSchema,
  OptimizationRequestedSchema,
] as const;

export const DomainEventSchema = z.discriminatedUnion("type", EVENT_SCHEMAS);
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const DOMAIN_EVENT_TYPES = [
  "ProductDiscovered",
  "ProductRanked",
  "CampaignCreated",
  "CreativeRequested",
  "CreativeGenerated",
  "CreativeApproved",
  "ContentScheduled",
  "ContentPublished",
  "ContentFailed",
  "ClickRecorded",
  "ConversionRecorded",
  "CommissionRecorded",
  "PerformanceWindowCompleted",
  "OptimizationRequested",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export const DOMAIN_EVENT_SCHEMAS = Object.fromEntries(
  EVENT_SCHEMAS.map((schema) => [schema.shape.type.value, schema]),
) as Record<DomainEventType, (typeof EVENT_SCHEMAS)[number]>;
