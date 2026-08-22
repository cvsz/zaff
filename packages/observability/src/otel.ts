// OpenTelemetry is an OPTIONAL integration. The @opentelemetry/* packages are
// declared as optional peerDependencies and are NEVER installed by default.
// initTracing() dynamically imports them only when OTEL_EXPORTER_OTLP_ENDPOINT
// is set, and any failure (missing package, bad config) degrades to a no-op so
// the application never crashes because tracing is unavailable.
//
// Upgrade path: `npm i @opentelemetry/api @opentelemetry/sdk-node` plus the
// desired exporter packages, then set OTEL_EXPORTER_OTLP_ENDPOINT. No code
// change is required here beyond exporter options if needed.

interface SdkInstance {
  start(): void;
  shutdown(): Promise<void>;
}

let sdk: SdkInstance | undefined;
let active = false;

export function isTracingEnabled(): boolean {
  return active;
}

export async function initTracing(serviceName: string): Promise<boolean> {
  if (active) return true;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;

  try {
    const sdkModuleName = "@opentelemetry/sdk-node";
    const sdkModule: {
      default?: new (options: unknown) => SdkInstance;
    } = await import(sdkModuleName);

    const NodeSDK = sdkModule.default;
    if (!NodeSDK) throw new Error("@opentelemetry/sdk-node has no default export");

    const instance = new NodeSDK({ serviceName });
    instance.start();
    sdk = instance;
    active = true;
  } catch {
    active = false;
  }
  return active;
}

export async function shutdownTracing(): Promise<boolean> {
  if (!active || !sdk) return false;
  active = false;
  try {
    await sdk.shutdown();
  } finally {
    sdk = undefined;
  }
  return true;
}
