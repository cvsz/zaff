import { z } from "zod";

export const PlatformCapabilitySchema = z.enum([
  "catalog.read",
  "offers.read",
  "links.create",
  "orders.read",
  "commissions.read",
  "content.publish",
  "video.publish",
  "image.publish",
  "analytics.read",
  "webhooks",
]);
export type PlatformCapability = z.infer<typeof PlatformCapabilitySchema>;
