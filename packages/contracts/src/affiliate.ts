import { z } from "zod";
import { PlatformCapabilitySchema } from "./capabilities.js";

export const AffiliateProviderStatusSchema = z.enum(["active", "disabled"]);
export type AffiliateProviderStatus = z.infer<typeof AffiliateProviderStatusSchema>;

export const AffiliateProviderSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  capabilities: z.array(PlatformCapabilitySchema),
  lastVerifiedAt: z.string().datetime().nullable(),
  status: AffiliateProviderStatusSchema,
  createdAt: z.string().datetime(),
});
export type AffiliateProvider = z.infer<typeof AffiliateProviderSchema>;

export const MerchantSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  providerId: z.string().uuid(),
  externalId: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  createdAt: z.string().datetime(),
});
export type Merchant = z.infer<typeof MerchantSchema>;

export const ProductStatusSchema = z.enum([
  "discovered",
  "evaluated",
  "selected",
  "archived",
]);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const ProductSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  merchantId: z.string().uuid().nullable(),
  externalId: z.string().min(1).max(255).nullable(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable(),
  priceAmount: z.number().nonnegative(),
  currency: z.string().length(3),
  status: ProductStatusSchema,
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type Product = z.infer<typeof ProductSchema>;

export const CommissionTypeSchema = z.enum(["percentage", "fixed"]);
export type CommissionType = z.infer<typeof CommissionTypeSchema>;

const money = z.number().nonnegative();

export const OfferSchema = z
  .object({
    id: z.string().uuid(),
    productId: z.string().uuid(),
    url: z.string().url(),
    commissionType: CommissionTypeSchema,
    commissionValue: money,
    promotionLabel: z.string().max(255).nullable(),
    startsAt: z.string().datetime().nullable(),
    endsAt: z.string().datetime().nullable(),
    active: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .superRefine((offer, ctx) => {
    if (offer.commissionType === "percentage" && offer.commissionValue > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["commissionValue"],
        message: "percentage commission cannot exceed 100",
      });
    }
  });
export type Offer = z.infer<typeof OfferSchema>;

export const CampaignStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "completed",
  "cancelled",
]);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const CAMPAIGN_TRANSITIONS: Readonly<
  Record<CampaignStatus, readonly CampaignStatus[]>
> = {
  draft: ["active", "cancelled"],
  active: ["paused", "completed", "cancelled"],
  paused: ["active", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransitionCampaign(
  from: CampaignStatus,
  to: CampaignStatus
): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

export const CampaignSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  name: z.string().min(1).max(255),
  status: CampaignStatusSchema,
  objective: z.string().max(500).nullable(),
  budgetLimit: money.nullable(),
  createdAt: z.string().datetime(),
});
export type Campaign = z.infer<typeof CampaignSchema>;

export const AffiliateLinkSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  campaignId: z.string().uuid().nullable(),
  offerId: z.string().uuid().nullable(),
  slug: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase letters, digits and hyphens"),
  targetUrl: z.string().url(),
  utm: z.record(z.string()),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type AffiliateLink = z.infer<typeof AffiliateLinkSchema>;

export const ConversionStatusSchema = z.enum([
  "pending",
  "confirmed",
  "refunded",
  "rejected",
]);
export type ConversionStatus = z.infer<typeof ConversionStatusSchema>;

export const ConversionSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  linkId: z.string().uuid().nullable(),
  externalOrderId: z.string().min(1).max(255),
  amount: money,
  currency: z.string().length(3),
  commissionAmount: money,
  status: ConversionStatusSchema,
  occurredAt: z.string().datetime(),
  recordedAt: z.string().datetime(),
});
export type Conversion = z.infer<typeof ConversionSchema>;

export const CreateConversionInputSchema = z
  .object({
    orgId: z.string().uuid(),
    linkId: z.string().uuid().nullable(),
    externalOrderId: z.string().min(1).max(255),
    amount: money,
    currency: z.string().length(3).default("USD"),
    commissionAmount: money.default(0),
    occurredAt: z.string().datetime(),
  })
  .superRefine((input, ctx) => {
    if (input.amount < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "amount must be >= 0",
      });
    }
    if (input.commissionAmount < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["commissionAmount"],
        message: "commissionAmount must be >= 0",
      });
    }
  });
export type CreateConversionInput = z.infer<typeof CreateConversionInputSchema>;
