import { createHmac, timingSafeEqual } from "node:crypto";

export const OAUTH_STATE_MAX_AGE_SEC = 600;

// DEV-ONLY fallback; production must set OAUTH_STATE_SECRET.
const DEV_STATE_SECRET = "zaff_dev_state_secret_change_me";

export interface StatePayload {
  nonce: string;
  issuedAt: number;
  redirectTo: string;
}

function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "ascii").digest("base64url");
}

export function createState(
  payload: StatePayload,
  secret: string = process.env.OAUTH_STATE_SECRET ?? DEV_STATE_SECRET
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${hmac(secret, body)}`;
}

export function verifyState(
  state: string,
  secret: string = process.env.OAUTH_STATE_SECRET ?? DEV_STATE_SECRET,
  options: { now?: number; maxAgeSec?: number } = {}
): StatePayload | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0 || dot === state.length - 1) return null;
  const body = state.slice(0, dot);
  const signature = Buffer.from(state.slice(dot + 1), "base64url");
  const expected = Buffer.from(hmac(secret, body), "base64url");
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.nonce !== "string" ||
    typeof candidate.redirectTo !== "string" ||
    typeof candidate.issuedAt !== "number" ||
    !Number.isFinite(candidate.issuedAt)
  ) {
    return null;
  }
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);
  const maxAgeSec = options.maxAgeSec ?? OAUTH_STATE_MAX_AGE_SEC;
  if (nowSec - candidate.issuedAt > maxAgeSec || candidate.issuedAt > nowSec + 60) {
    return null;
  }
  return payload as unknown as StatePayload;
}
