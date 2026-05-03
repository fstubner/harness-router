/**
 * Single source of truth for the package version.
 *
 * Read from `package.json` at module load so the value never drifts from the
 * published tag. Three call sites previously hardcoded their own copy of the
 * version string and went stale on every release; this module exists so they
 * can all import one constant instead.
 *
 * Resolution: walks up from this file's location to find `package.json`.
 * Works under both `tsx` (src/version.ts → ../package.json) and the built
 * `dist/version.js → ../package.json` because the relative depth is the same.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The current package version. Read once from package.json at module load. */
export const VERSION: string = readPackageVersion();
