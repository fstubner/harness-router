/**
 * OpenTelemetry initialization for harness-router.
 *
 * Call `initObservability()` once at process startup (from the CLI or MCP
 * server entry points). Subsequent calls are no-ops. If the environment
 * variable `OTEL_SDK_DISABLED=true` is set, initialization is skipped
 * entirely — useful for tests and for operators who don't want traces.
 *
 * The SDK exports OTLP/HTTP to `http://localhost:4318/v1/traces` by default.
 * Override with `OTEL_EXPORTER_OTLP_ENDPOINT` (standard env var) or by passing
 * `otlpUrl` to `initObservability`.
 *
 * Auto-instrumentation of Node core (http, fs, child_process, etc.) is
 * installed so dispatcher subprocess spawns and fetch calls are traced out
 * of the box alongside our manual dispatcher/router/MCP spans.
 */

import type { Span } from "@opentelemetry/api";

import { VERSION } from "../version.js";

const SERVICE_NAME_DEFAULT = "harness-router";
const SERVICE_VERSION = VERSION;

export interface InitObservabilityOpts {
  /** Override the OTLP endpoint. Defaults to OTEL_EXPORTER_OTLP_ENDPOINT or http://localhost:4318. */
  otlpUrl?: string;
  /** Override the service name attached to spans. Defaults to harness-router. */
  serviceName?: string;
  /** Inject instrumentations for tests — production uses auto-instrumentations. */
  instrumentations?: unknown[];
}

let initialized = false;
let sdkRef: { shutdown: () => Promise<void> } | null = null;

/**
 * Initialize the OpenTelemetry SDK. Idempotent.
 *
 * Returns true if the SDK was initialized by this call, false if it was
 * already running (or if disabled via `OTEL_SDK_DISABLED=true`).
 */
export async function initObservability(opts: InitObservabilityOpts = {}): Promise<boolean> {
  if (initialized) return false;
  if (process.env["OTEL_SDK_DISABLED"] === "true") {
    initialized = true;
    return false;
  }

  // Lazily import so consumers who never call initObservability don't pay the
  // load cost or pick up auto-instrumentations they didn't ask for.
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");

  const otlpEndpoint =
    opts.otlpUrl ?? process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://localhost:4318";

  const exporter = new OTLPTraceExporter({
    url: `${otlpEndpoint.replace(/\/+$/, "")}/v1/traces`,
  });

  // Pull auto-instrumentations on demand — keeps cold-start cheap when tests
  // bring their own (empty) instrumentation set.
  let instrumentations = opts.instrumentations;
  if (instrumentations === undefined) {
    try {
      const auto = await import("@opentelemetry/auto-instrumentations-node");
      instrumentations = [auto.getNodeAutoInstrumentations()];
    } catch {
      instrumentations = [];
    }
  }

  const serviceName = opts.serviceName ?? SERVICE_NAME_DEFAULT;

  // NodeSDK's `resource` type changed shape across 0.50.x → 0.52.x. Pass
  // attributes via env var to stay version-agnostic — that's the supported
  // compat path.
  const existingRes = process.env["OTEL_RESOURCE_ATTRIBUTES"] ?? "";
  const resourceParts = [`service.name=${serviceName}`, `service.version=${SERVICE_VERSION}`];
  process.env["OTEL_RESOURCE_ATTRIBUTES"] = existingRes
    ? `${existingRes},${resourceParts.join(",")}`
    : resourceParts.join(",");

  // Pin the instrumentations field's type so a future SDK upgrade that
  // reshapes the constructor's first arg surfaces the mismatch here
  // rather than silently propagating `never` (the previous `as never`
  // workaround). The runtime value is whatever auto-instrumentations-node
  // produces and conforms structurally; only the package-versioned type
  // sometimes doesn't line up with NodeSDK's expected shape.
  //
  // `NonNullable<>` strips the optional wrapper around the constructor's
  // arg; the inner index pulls the field. With `exactOptionalPropertyTypes`
  // we have to widen `undefined` away because the SDK's field is non-
  // optional even though `Partial<NodeSDKConfiguration>` makes the parent
  // optional — `NonNullable` on the outer doesn't narrow inner properties.
  type SdkInstrumentations = NonNullable<
    NonNullable<ConstructorParameters<typeof NodeSDK>[0]>["instrumentations"]
  >;
  // TS narrows `instrumentations` to non-undefined after the if/try/catch
  // (every reachable branch assigns), so no `!` needed. The cast widens
  // from `unknown[]` to the SDK-versioned tuple shape.
  const sdk = new NodeSDK({
    traceExporter: exporter,
    instrumentations: instrumentations as SdkInstrumentations,
  });

  try {
    sdk.start();
    sdkRef = { shutdown: () => sdk.shutdown() };
    initialized = true;
    return true;
  } catch (err) {
    // SDK failed to start — don't crash the host, but surface the reason on
    // stderr. Otherwise an operator who configured OTEL_EXPORTER_OTLP_ENDPOINT
    // and sees zero traces has no signal that init silently failed. Stderr
    // (not stdout) is intentional: stdout is reserved for MCP JSON-RPC.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[harness-router] OpenTelemetry SDK failed to start: ${msg}\n`);
    return false;
  }
}

/** Shut down the observability SDK (drains pending spans). Idempotent. */
export async function shutdownObservability(): Promise<void> {
  if (!sdkRef) return;
  try {
    await sdkRef.shutdown();
  } catch {
    // best-effort drain
  }
  sdkRef = null;
  initialized = false;
}

/** Reset internal state — tests only. */
export function _resetObservabilityForTests(): void {
  initialized = false;
  sdkRef = null;
}

export { withDispatcherSpan, withRouterSpan, withMcpToolSpan } from "./spans.js";
export type { SpanAttrs } from "./spans.js";
export type { Span };
