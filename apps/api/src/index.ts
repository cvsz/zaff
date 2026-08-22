import { createLogger, initTracing } from "@zaff/observability";
import { createDb } from "@zaff/db";
import { assertNoDevSecrets, resolveAuthService } from "./bootstrap.js";
import { DEFAULT_CLICK_SALT } from "./link-routes.js";
import { startServer } from "./server.js";

const logger = createLogger({ name: "api" });
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

initTracing("zaff-api")
  .then((enabled) => {
    if (!enabled) logger.debug("tracing disabled (set OTEL_EXPORTER_OTLP_ENDPOINT to enable)");
  })
  .catch(() => {});

try {
  assertNoDevSecrets(process.env);
} catch (error) {
  logger.error({ err: error }, "dev-secret guard failed");
  process.exit(1);
}

let authService;
try {
  authService = resolveAuthService(process.env);
} catch (error) {
  logger.error({ err: error }, "failed to configure auth service");
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL!);
const clickSalt = process.env.CLICK_SALT ?? DEFAULT_CLICK_SALT;

startServer(port, {
  logger,
  authService,
  linkRoutes: { db, authService, clickSalt, logger },
  campaignRoutes: { db, authService, logger },
})
  .then((server) => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    logger.info({ port: actualPort }, "api listening");
  })
  .catch((error) => {
    logger.error({ err: error }, "failed to start api");
    process.exit(1);
  });
