import pino from "pino";

export const REDACTED = "[Redacted]";

// Fields whose values must never appear in logs.
export const SENSITIVE_FIELDS = [
  "password",
  "token",
  "sessionToken",
  "cookie",
  "authorization",
  "set-cookie",
];

// pino/fast-redact supports single-level "*" wildcards only ("**" is not
// honored), so we enumerate each field down to three levels of object nesting.
// Do NOT pass sensitive values inside arrays of objects; they are not matched
// by these paths.
export const REDACTION_PATHS: string[] = SENSITIVE_FIELDS.flatMap((field) => [
  field,
  `*.${field}`,
  `*.*.${field}`,
  `*.*.*.${field}`,
]);

export type DestinationStream = pino.DestinationStream;

export interface LoggerOptions {
  name?: string;
  level?: string;
  stream?: DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): pino.Logger {
  const opts: pino.LoggerOptions = {
    name: options.name ?? "zaff",
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACTION_PATHS, censor: REDACTED },
  };
  return options.stream ? pino(opts, options.stream) : pino(opts);
}

export type Logger = pino.Logger;
