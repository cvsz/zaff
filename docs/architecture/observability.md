# Observability

Status: baseline (FND-6). Package: `packages/observability` (`@zaff/observability`).

## Logging

All services log structured JSON via [pino](https://getpino.io).

```ts
import { createLogger } from "@zaff/observability";

const logger = createLogger({ name: "api" });
logger.info({ requestId, userId }, "user authenticated");
```

Conventions:

- One logger per service/app, named after it (`api`, `auth`, `worker`, ...).
- First argument is the fields object, second is the human message.
- Log **pathname only** for request URLs — never full URLs, because query
  strings can carry tokens (`/go/x?sessionToken=...` is logged as `/go/x`).
- Request logs use the shared helper `logRequest(logger, { method, url,
  status, durationMs, requestId })`; `requestId` is passed through from the
  inbound `x-request-id` header or generated with `crypto.randomUUID()`.
- Never pass credentials, tokens, or session values as log fields. Redaction is
  a safety net, not an excuse.

## Redaction

`createLogger` installs default pino redaction with censor `[Redacted]`
(`REDACTED` constant) over `REDACTION_PATHS`, covering these field names:

| Field           | Also matches (nested up to 3 object levels) |
| --------------- | ------------------------------------------- |
| `password`      | `*.password`, `*.*.password`, `*.*.*.password` |
| `token`         | idem                                        |
| `sessionToken`  | idem                                        |
| `cookie`        | idem                                        |
| `authorization` | idem                                        |
| `set-cookie`    | idem                                        |

Known limitations (documented, accepted at FND-6):

- pino/fast-redact does not honor `**` deep wildcards, so paths are enumerated
  to three levels of nesting.
- Sensitive values inside **arrays of objects** ARE redacted in practice
  (fast-redact treats array indices as wildcard keys — verified empirically),
  but do not rely on this; do not log secrets.
- Redaction is defense-in-depth; code must still avoid logging secrets.

## Tracing (opt-in)

OpenTelemetry support exists behind `initTracing(serviceName)` in `otel.ts`:

- Disabled unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- `@opentelemetry/*` packages are declared as **optional peerDependencies** and
  are dynamically imported inside try/catch; if they are not installed or fail
  to start, tracing silently stays disabled and the process never crashes.
- To enable: `npm i @opentelemetry/api @opentelemetry/sdk-node` plus your
  exporter packages, set `OTEL_EXPORTER_OTLP_ENDPOINT`, restart.

## Metrics

Planned (not yet implemented). Intended first metrics follow AGENTS.md §26:
publishing failures, API failures, token expiration, generation failures,
render latency, queue lag, conversion import failures, webhook failures, AI
spend. `startTimer()` in `timer.ts` returns an `end(label?) → durationMs`
helper reserved for cost/latency instrumentation.

## Testing hooks

`createLogger({ stream })` accepts any pino destination stream; tests inject a
memory sink to assert on emitted JSON lines (see
`packages/observability/src/logger.test.ts` and
`apps/api/test/request-log.integration.test.ts`).
