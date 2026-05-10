/**
 * `harness-router list-services` — print enabled services with their
 * harness/tier/model metadata. Useful when debugging "why is the router
 * picking this CLI" — you can see exactly what it considers configured.
 */

import { loadConfig } from "../config/index.js";

export async function cmdListServices(configPath: string | undefined): Promise<number> {
  const config = await loadConfig(configPath);
  const rows: string[] = [];
  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.enabled) continue;
    const harness = svc.harness ?? name;
    const parts = [
      name,
      `harness=${harness}`,
      `tier=${svc.tier ?? "subscription"}`,
      svc.model ? `model=${svc.model}` : "",
    ].filter(Boolean);
    rows.push(parts.join("  "));
  }
  if (rows.length === 0) {
    process.stdout.write("(no enabled services)\n");
  } else {
    for (const r of rows) process.stdout.write(`${r}\n`);
  }
  return 0;
}
