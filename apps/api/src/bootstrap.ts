import { AuthService } from "@zaff/auth";
import { createDb } from "@zaff/db";
import { DEV_WEBHOOK_SECRET } from "./campaign-routes.js";
import { DEFAULT_CLICK_SALT } from "./link-routes.js";

// Keep in sync with the dev-only fallbacks in oauth-routes.ts,
// packages/storage/src/signing.ts, link-routes.ts (CLICK_SALT), and
// campaign-routes.ts (WEBHOOK_INGEST_SECRET); production must override all of them.
const DEV_DEFAULT_SECRETS: ReadonlyArray<{ envVar: string; devValue: string }> = [
  { envVar: "OAUTH_STATE_SECRET", devValue: "zaff_dev_state_secret_change_me" },
  { envVar: "STORAGE_SIGNING_SECRET", devValue: "zaff_dev_signing_secret_change_me" },
  { envVar: "CLICK_SALT", devValue: DEFAULT_CLICK_SALT },
  { envVar: "WEBHOOK_INGEST_SECRET", devValue: DEV_WEBHOOK_SECRET },
];

export class DevSecretError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(
      `refusing to boot: dev-default secrets in production\n- ${violations.join("\n- ")}`
    );
    this.name = "DevSecretError";
    this.violations = violations;
  }
}

export function findDevSecretViolations(
  env: NodeJS.ProcessEnv,
  nodeEnv: string | undefined = env.NODE_ENV
): string[] {
  if (nodeEnv !== "production") return [];
  const violations: string[] = [];
  for (const { envVar, devValue } of DEV_DEFAULT_SECRETS) {
    const value = env[envVar];
    if (value === undefined || value === "") {
      violations.push(`${envVar} is unset; the documented dev-default fallback would be used`);
    } else if (value === devValue) {
      violations.push(`${envVar} is set to the known dev-default value`);
    }
  }
  return violations;
}

export function assertNoDevSecrets(
  env: NodeJS.ProcessEnv,
  nodeEnv?: string
): void {
  const violations = findDevSecretViolations(env, nodeEnv);
  if (violations.length > 0) throw new DevSecretError(violations);
}

export function resolveAuthService(env: NodeJS.ProcessEnv): AuthService {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set; cannot start auth service (e.g. postgres://user:pass@host:5432/db)"
    );
  }
  return new AuthService(createDb(databaseUrl));
}
