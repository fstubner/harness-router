/**
 * `harness-router doctor` — health check across installed AI CLIs.
 *
 * Default mode: probe each detected harness once (`installed + authed +
 * version-readable`). The `--probe-routes` flag adds a per-(harness, model)
 * dispatch test against every route in the config — surfaces "model
 * rejected by CLI" diagnostics that the harness-level probe can't see.
 */

import {
  onboard,
  renderReport,
  verifyAllRoutes,
  type HarnessId,
  type OnboardOptions,
} from "../harnesses.js";

export async function cmdDoctor(
  configPath: string | undefined,
  installFlag: boolean,
  noVerify: boolean,
  harnessFilter: HarnessId | undefined,
  probeRoutes: boolean,
): Promise<number> {
  const opts: OnboardOptions = {
    install: installFlag,
    noVerify,
  };
  if (configPath !== undefined) opts.configPath = configPath;
  if (harnessFilter !== undefined) opts.harnesses = [harnessFilter];

  const reports = await onboard(opts);
  const colors = Boolean(process.stdout.isTTY);
  process.stdout.write(renderReport(reports, colors) + "\n");

  // --probe-routes: dispatch a tiny prompt against every (harness, model)
  // route in the config. The harness-level verify above already probes
  // ONE service per harness; this catches "model rejected by CLI" for
  // additional routes that share a harness.
  if (probeRoutes) {
    process.stdout.write("\n  Probing every configured route…\n\n");
    const results = await verifyAllRoutes(configPath);
    if (results.length === 0) {
      process.stdout.write("  (no enabled routes in config)\n");
    } else {
      for (const r of results) {
        const tag = r.ok ? "✓" : "✗";
        const ms = `${r.durationMs}ms`;
        const where = r.baseUrl ?? r.harness;
        process.stdout.write(
          `  [${tag}] ${r.serviceId.padEnd(40)} model=${r.model} via=${where} ${ms}\n`,
        );
        if (!r.ok && r.error) {
          process.stdout.write(`      → ${r.error}\n`);
        }
      }
    }
    const allOk = results.every((r) => r.ok);
    return reports.every((r) => r.ready) && allOk ? 0 : 1;
  }

  // Exit 0 if every targeted harness is ready, 1 otherwise — useful for
  // shell scripts ("&& open editor", etc.).
  return reports.every((r) => r.ready) ? 0 : 1;
}
