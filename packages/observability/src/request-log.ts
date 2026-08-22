import { randomUUID } from "node:crypto";
import type pino from "pino";

export interface RequestLogFields {
  method: string;
  url: string;
  status: number;
  durationMs: number;
  requestId?: string;
}

export function pathnameOnly(url: string): string {
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

export function logRequest(logger: pino.Logger, fields: RequestLogFields): string {
  const requestId = fields.requestId ?? randomUUID();
  logger.info(
    {
      requestId,
      method: fields.method,
      url: pathnameOnly(fields.url),
      status: fields.status,
      durationMs: Math.round(fields.durationMs * 1000) / 1000,
    },
    "request"
  );
  return requestId;
}

export type RequestLogFn = (fields: RequestLogFields) => string;

export function requestLogMiddleware(logger: pino.Logger): RequestLogFn {
  return (fields) => logRequest(logger, fields);
}
