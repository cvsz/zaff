import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  AuthError,
  atLeast,
  requireRole,
  requireUser,
  type AuthService,
} from "@zaff/auth";
import {
  aggregateCommissionByOrg,
  appendAuditEvent,
  createAffiliateLink,
  createCampaign,
  getOfferById,
  listCampaignsByOrg,
  listConversionsByOrg,
  recordConversion,
  resolveLinkBySlug,
  SlugTakenError,
  transitionCampaignStatus,
  IllegalTransitionError,
  getProviderByCode,
  type CampaignStatus,
  type ConversionRow,
  type Db,
} from "@zaff/db";
import type { Logger } from "@zaff/observability";

const CSRF_HEADER = "x-requested-with";
const CSRF_HEADER_VALUE = "zaff";
const MAX_BODY_BYTES = 16 * 1024;
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
export const DEV_WEBHOOK_SECRET = "zaff_dev_webhook_secret_change_me";

export interface CampaignEventBus {
  publish(event: unknown): Promise<void>;
}

export interface CampaignRouteDeps {
  db: Db;
  authService: AuthService;
  bus?: CampaignEventBus;
  logger?: Logger;
  appBaseUrl?: string;
  webhookSecrets?: Record<string, string>;
}

export interface CampaignRouteResult {
  handled: boolean;
}

export type CampaignRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
) => Promise<CampaignRouteResult>;

const CreateCampaignRequestSchema = z.object({
  name: z.string().min(1).max(255),
  objective: z.string().max(500).nullish(),
  budgetLimit: z.number().nonnegative().nullish(),
});

const CampaignStatusRequestSchema = z.object({
  status: z.enum(["draft", "active", "paused", "completed", "cancelled"]),
});

const CreateLinkRequestSchema = z.object({
  slug: z
    .string()
    .max(128)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  offerId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  targetUrl: z.string().url(),
  utm: z.record(z.string()).optional(),
});

export const WebhookConversionPayloadSchema = z.object({
  externalOrderId: z.string().min(1).max(255),
  linkSlug: z.string().min(1).max(128),
  amount: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  occurredAt: z.string().datetime(),
  status: z.enum(["pending", "confirmed", "refunded", "rejected"]).default("pending"),
});

type WebhookConversionPayload = z.infer<typeof WebhookConversionPayloadSchema>;

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new AuthError(413, "payload_too_large", "request body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AuthError(400, "invalid_json", "request body must be valid JSON");
  }
}

function getCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isCsrfOk(req: IncomingMessage): boolean {
  return headerValue(req, CSRF_HEADER) === CSRF_HEADER_VALUE;
}

function zodIssueSummary(error: z.ZodError): string[] {
  return error.issues.map((issue) => issue.path.join(".") || "(root)");
}

function serializeCampaign(campaign: {
  id: string;
  orgId: string;
  name: string;
  status: string;
  objective: string | null;
  budgetLimit: string | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: campaign.id,
    orgId: campaign.orgId,
    name: campaign.name,
    status: campaign.status,
    objective: campaign.objective,
    budgetLimit: campaign.budgetLimit,
    createdAt: campaign.createdAt.toISOString(),
  };
}

function serializeLink(link: {
  id: string;
  orgId: string;
  campaignId: string | null;
  offerId: string | null;
  slug: string;
  targetUrl: string;
  utm: Record<string, string>;
  expiresAt: Date | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: link.id,
    orgId: link.orgId,
    campaignId: link.campaignId,
    offerId: link.offerId,
    slug: link.slug,
    targetUrl: link.targetUrl,
    utm: link.utm,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
  };
}

function serializeConversion(conversion: ConversionRow): Record<string, unknown> {
  return {
    id: conversion.id,
    orgId: conversion.orgId,
    linkId: conversion.linkId,
    externalOrderId: conversion.externalOrderId,
    amount: conversion.amount,
    currency: conversion.currency,
    commissionAmount: conversion.commissionAmount,
    status: conversion.status,
    occurredAt: conversion.occurredAt.toISOString(),
    recordedAt: conversion.recordedAt.toISOString(),
  };
}

function resolveIngestSecret(providerCode: string, deps: CampaignRouteDeps): string {
  const override = deps.webhookSecrets?.[providerCode];
  if (override) return override;
  const envKey = `WEBHOOK_INGEST_SECRET_${providerCode.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const specific = process.env[envKey];
  if (specific) return specific;
  const shared = process.env.WEBHOOK_INGEST_SECRET;
  if (shared) return shared;
  // Dev-only fallback; bootstrap's assertNoDevSecrets guards production use.
  return DEV_WEBHOOK_SECRET;
}

function verifyWebhookSignature(
  providerCode: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  rawBody: Buffer,
  secret: string
): void {
  if (!timestampHeader || !signatureHeader) {
    throw new AuthError(401, "invalid_signature", "missing webhook authentication headers");
  }
  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) {
    throw new AuthError(401, "invalid_signature", "invalid webhook authentication headers");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new AuthError(401, "replay_rejected", "webhook timestamp outside allowed window");
  }
  if (!/^[0-9a-f]{64}$/i.test(signatureHeader)) {
    throw new AuthError(401, "invalid_signature", "signature verification failed");
  }
  const expected = createHmac("sha256", secret)
    .update(`${providerCode}.${timestampHeader}.${rawBody.toString("utf8")}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(signatureHeader.toLowerCase(), "hex");
  if (
    expectedBuf.length !== receivedBuf.length ||
    !timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    throw new AuthError(401, "invalid_signature", "signature verification failed");
  }
}

function computeCommission(
  offer: { commissionType: string; commissionValue: string } | null,
  amount: number
): number {
  if (!offer) return 0;
  const value = Number.parseFloat(offer.commissionValue);
  const computed =
    offer.commissionType === "percentage" ? (amount * value) / 100 : value;
  return Math.round(computed * 100) / 100;
}

async function handleCampaignEndpoints(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: CampaignRouteDeps
): Promise<CampaignRouteResult> {
  const method = req.method ?? "";

  const campaignsMatch = /^\/orgs\/([0-9a-fA-F-]{36})\/campaigns$/.exec(pathname);
  if (campaignsMatch) {
    const requester = requireUser(
      await deps.authService.getSessionUser(getCookie(req, "zaff_session"))
    );
    const orgId = campaignsMatch[1] as string;
    if (requester.orgId !== orgId) {
      throw new AuthError(403, "forbidden", "cross-org access denied");
    }

    if (method === "POST") {
      if (!isCsrfOk(req)) {
        throw new AuthError(403, "csrf_required", `missing header ${CSRF_HEADER}: ${CSRF_HEADER_VALUE}`);
      }
      requireRole(requester, "org:write");
      const parsed = CreateCampaignRequestSchema.parse(await readJsonBody(req));
      try {
        const campaign = await createCampaign(deps.db, {
          orgId,
          name: parsed.name,
          objective: parsed.objective ?? null,
          budgetLimit: parsed.budgetLimit ?? null,
        });
        sendJson(res, 201, { campaign: serializeCampaign(campaign) });
        return { handled: true };
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new AuthError(409, "duplicate_name", "campaign name already exists for this org");
        }
        throw error;
      }
    }

    if (method === "GET") {
      if (!atLeast(requester.role, "member")) {
        throw new AuthError(403, "forbidden", "member role required");
      }
      const campaigns = await listCampaignsByOrg(deps.db, orgId);
      sendJson(res, 200, { campaigns: campaigns.map(serializeCampaign) });
      return { handled: true };
    }

    return { handled: false };
  }

  const statusMatch = /^\/orgs\/([0-9a-fA-F-]{36})\/campaigns\/([0-9a-fA-F-]{36})\/status$/.exec(pathname);
  if (statusMatch && method === "PATCH") {
    if (!isCsrfOk(req)) {
      throw new AuthError(403, "csrf_required", `missing header ${CSRF_HEADER}: ${CSRF_HEADER_VALUE}`);
    }
    const requester = requireUser(
      await deps.authService.getSessionUser(getCookie(req, "zaff_session"))
    );
    const orgId = statusMatch[1] as string;
    if (requester.orgId !== orgId) {
      throw new AuthError(403, "forbidden", "cross-org access denied");
    }
    requireRole(requester, "org:write");
    const parsed = CampaignStatusRequestSchema.parse(await readJsonBody(req));
    try {
      const updated = await transitionCampaignStatus(
        deps.db,
        orgId,
        statusMatch[2] as string,
        parsed.status as CampaignStatus
      );
      if (!updated) {
        throw new AuthError(404, "not_found", "campaign not found");
      }
      sendJson(res, 200, { campaign: serializeCampaign(updated) });
      return { handled: true };
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        throw new AuthError(409, "transition_illegal", error.message);
      }
      throw error;
    }
  }

  const linksMatch = /^\/orgs\/([0-9a-fA-F-]{36})\/links$/.exec(pathname);
  if (linksMatch && method === "POST") {
    if (!isCsrfOk(req)) {
      throw new AuthError(403, "csrf_required", `missing header ${CSRF_HEADER}: ${CSRF_HEADER_VALUE}`);
    }
    const requester = requireUser(
      await deps.authService.getSessionUser(getCookie(req, "zaff_session"))
    );
    const orgId = linksMatch[1] as string;
    if (requester.orgId !== orgId) {
      throw new AuthError(403, "forbidden", "cross-org access denied");
    }
    requireRole(requester, "org:write");
    const parsed = CreateLinkRequestSchema.parse(await readJsonBody(req));
    try {
      const link = await createAffiliateLink(deps.db, {
        orgId,
        slug: parsed.slug ?? randomUUID().replace(/-/g, "").slice(0, 12),
        offerId: parsed.offerId ?? null,
        campaignId: parsed.campaignId ?? null,
        targetUrl: parsed.targetUrl,
        utm: parsed.utm ?? {},
      });
      const base = (deps.appBaseUrl ?? process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
      sendJson(res, 201, {
        link: serializeLink(link),
        slug: link.slug,
        shortUrl: `${base}/go/${link.slug}`,
      });
      return { handled: true };
    } catch (error) {
      if (error instanceof SlugTakenError) {
        throw new AuthError(409, "slug_taken", "affiliate link slug already taken");
      }
      throw error;
    }
  }

  const conversionsMatch = /^\/orgs\/([0-9a-fA-F-]{36})\/conversions$/.exec(pathname);
  if (conversionsMatch && method === "GET") {
    const requester = requireUser(
      await deps.authService.getSessionUser(getCookie(req, "zaff_session"))
    );
    const orgId = conversionsMatch[1] as string;
    if (requester.orgId !== orgId) {
      throw new AuthError(403, "forbidden", "cross-org access denied");
    }
    requireRole(requester, "org:write");

    const url = new URL(req.url ?? "/", "http://localhost");
    const parseDateParam = (name: string): Date | null => {
      const value = url.searchParams.get(name);
      if (!value) return null;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        throw new AuthError(400, "invalid_request", `query parameter '${name}' must be an ISO date`);
      }
      return date;
    };
    const options = { from: parseDateParam("from"), to: parseDateParam("to") };

    const [conversions, summary] = await Promise.all([
      listConversionsByOrg(deps.db, orgId, options),
      aggregateCommissionByOrg(deps.db, orgId, options),
    ]);
    sendJson(res, 200, {
      conversions: conversions.map(serializeConversion),
      summary,
    });
    return { handled: true };
  }

  return { handled: false };
}

async function handleWebhookEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  providerCode: string,
  deps: CampaignRouteDeps
): Promise<void> {
  const rawBody = await readRawBody(req);

  verifyWebhookSignature(
    providerCode,
    headerValue(req, "x-zaff-timestamp"),
    headerValue(req, "x-zaff-signature"),
    rawBody,
    resolveIngestSecret(providerCode, deps)
  );

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new AuthError(400, "invalid_json", "request body must be valid JSON");
  }
  const parsed = WebhookConversionPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: "invalid_payload",
      message: "webhook payload validation failed",
      issues: zodIssueSummary(parsed.error),
    });
    return;
  }
  const payload: WebhookConversionPayload = parsed.data;

  const link = await resolveLinkBySlug(deps.db, payload.linkSlug);
  if (!link) {
    throw new AuthError(422, "unresolvable_link", "link could not be resolved");
  }

  const provider = await getProviderByCode(deps.db, link.orgId, providerCode);
  if (!provider) {
    throw new AuthError(404, "unknown_provider", "unknown affiliate provider");
  }

  const offer = link.offerId
    ? await getOfferById(deps.db, link.orgId, link.offerId)
    : null;
  const commissionAmount = computeCommission(offer, payload.amount);

  const result = await recordConversion(deps.db, {
    orgId: link.orgId,
    linkId: link.id,
    externalOrderId: payload.externalOrderId,
    amount: payload.amount,
    currency: payload.currency,
    commissionAmount,
    occurredAt: new Date(payload.occurredAt),
  });

  if (!result.inserted) {
    sendJson(res, 200, { deduped: true });
    return;
  }

  if (deps.bus) {
    await deps.bus.publish({
      type: "ConversionRecorded",
      id: randomUUID(),
      orgId: link.orgId,
      occurredAt: new Date().toISOString(),
      actor: "system",
      conversionId: result.conversion.id,
      orderId: payload.externalOrderId,
      amountCents: Math.round(payload.amount * 100),
      currency: payload.currency,
    });
  }

  await appendAuditEvent(deps.db, {
    orgId: link.orgId,
    actorUserId: null,
    action: "conversion.webhook_recorded",
    targetType: "conversion",
    targetId: result.conversion.id,
    metadata: { providerCode },
  });

  deps.logger?.info(
    { providerCode, conversionId: result.conversion.id },
    "affiliate conversion recorded from webhook"
  );

  sendJson(res, 200, {
    deduped: false,
    conversion: serializeConversion(result.conversion),
  });
}

export function registerCampaignRoutes(deps: CampaignRouteDeps): CampaignRouteHandler {
  return async function handleCampaignRoute(req, res, pathname) {
    if (pathname.startsWith("/orgs/")) {
      try {
        return await handleCampaignEndpoints(req, res, pathname, deps);
      } catch (error) {
        handleError(res, error);
        return { handled: true };
      }
    }

    const webhookMatch = /^\/webhooks\/affiliates\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (webhookMatch && (req.method ?? "") === "POST") {
      try {
        await handleWebhookEndpoint(req, res, webhookMatch[1] as string, deps);
      } catch (error) {
        handleError(res, error);
      }
      return { handled: true };
    }

    return { handled: false };
  };
}

function handleError(res: ServerResponse, error: unknown): void {
  if (error instanceof AuthError) {
    sendJson(res, error.status, { error: error.code, message: error.message });
    return;
  }
  if (error instanceof IllegalTransitionError) {
    sendJson(res, 409, { error: "transition_illegal", message: error.message });
    return;
  }
  if (error instanceof SlugTakenError) {
    sendJson(res, 409, { error: "slug_taken", message: "affiliate link slug already taken" });
    return;
  }
  if (error && typeof error === "object" && "issues" in error) {
    sendJson(res, 400, {
      error: "invalid_request",
      message: "request validation failed",
      issues: zodIssueSummary(error as z.ZodError),
    });
    return;
  }
  sendJson(res, 500, { error: "internal", message: "unexpected error" });
}
