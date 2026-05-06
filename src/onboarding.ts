/**
 * Light onboarding flow for the five supported harnesses.
 *
 * Each harness has up to three states:
 *   - installed   the CLI is on PATH and `--version` returns
 *   - verified    a tiny dispatch through the project's own infrastructure
 *                 returns success
 *   - ready       installed && verified  (or installed && verify was skipped)
 *
 * `onboard()` runs all checks and returns a structured report. `runInstall()`
 * attempts `npm install -g <pkg>@latest` for harnesses with an npm package,
 * detecting EPERM/EACCES on Windows non-admin or Unix non-sudo and surfacing
 * a clear "re-run from elevated shell" hint instead of failing opaquely.
 *
 * The renderer is pure — it takes the report + a `colors` flag and returns a
 * string. CLI uses TTY-aware colors; the MCP tool consumes the structured
 * report directly.
 */

import { spawn } from "node:child_process";
import which from "which";

import { loadConfig } from "./config.js";
import { buildDispatchers } from "./mcp/dispatcher-factory.js";
import type { Dispatcher } from "./dispatchers/base.js";
import { detectRateLimitInText } from "./dispatchers/shared/rate-limit-text.js";
import type { RouterConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Harness specs
// ---------------------------------------------------------------------------

/**
 * Harness identifier. The five built-in harnesses have well-known names;
 * generic_cli services declared in config contribute additional ids at
 * runtime (the service's `name` becomes its harness id once
 * `loadGenericCliSpecs()` is folded into the onboarding probe).
 *
 * Modeled as `string` rather than a closed union so dynamic discovery can
 * extend the set. Callers that care specifically about a built-in harness
 * should compare against the `BUILTIN_HARNESS_IDS` set below.
 */
export type HarnessId = string;

export const BUILTIN_HARNESS_IDS = [
  "claude_code",
  "codex",
  "copilot",
  "cursor",
  "gemini_cli",
  "opencode",
] as const;

export interface HarnessSpec {
  harness: HarnessId;
  displayName: string;
  /** Binary name on PATH. */
  command: string;
  /** Argument that prints version info. */
  versionArg: string;
  /** npm package, when upgradable that way. Cursor's agent ships with the desktop app. */
  npmPackage?: string;
  /** Human-readable note for harnesses without an npm package. */
  installNotes?: string;
  /** URL to send users to for harnesses without a package-manager install. */
  installUrl?: string;
  /** Suggested auth command, surfaced when verification fails with an auth-y error. */
  authCommand: string;
}

export const HARNESS_SPECS: readonly HarnessSpec[] = [
  {
    harness: "claude_code",
    displayName: "Claude Code CLI",
    command: "claude",
    versionArg: "--version",
    npmPackage: "@anthropic-ai/claude-code",
    authCommand: "claude auth login",
  },
  {
    harness: "codex",
    displayName: "OpenAI Codex CLI",
    command: "codex",
    versionArg: "--version",
    npmPackage: "@openai/codex",
    authCommand: "codex auth login",
  },
  {
    harness: "cursor",
    displayName: "Cursor agent",
    command: "agent",
    versionArg: "--version",
    installNotes: "ships with the Cursor desktop app",
    installUrl: "https://cursor.com/download",
    authCommand: "sign in via the Cursor desktop app",
  },
  {
    harness: "gemini_cli",
    displayName: "Gemini CLI",
    command: "gemini",
    versionArg: "--version",
    npmPackage: "@google/gemini-cli",
    authCommand: "gemini auth   (or set GEMINI_API_KEY)",
  },
  {
    harness: "opencode",
    displayName: "OpenCode",
    command: "opencode",
    versionArg: "--version",
    npmPackage: "opencode-ai",
    authCommand: "opencode auth login   (Anthropic / OpenAI / Google subscriptions)",
  },
  {
    harness: "copilot",
    displayName: "GitHub Copilot CLI",
    command: "copilot",
    versionArg: "--version",
    npmPackage: "@github/copilot",
    // Copilot uses the GitHub auth host (gh login or copilot's own first-run
    // OAuth flow). There's no `copilot auth login` subcommand. Org policy
    // can also block CLI access independently — check
    // https://github.com/settings/copilot if "Access denied by policy".
    authCommand:
      "first-run OAuth (just run `copilot`)   |   org policy: https://github.com/settings/copilot",
  },
];

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface HarnessReport {
  harness: HarnessId;
  displayName: string;
  installed: boolean;
  installedVersion?: string;
  latestVersion?: string;
  upgradeAvailable: boolean;
  npmPackage?: string;
  installNotes?: string;
  installUrl?: string;
  /** Suggested install command. Undefined for the desktop-app case. */
  installCommand?: string;
  installAttempted: boolean;
  installResult?: { ok: boolean; needsAdmin?: boolean; error?: string };
  verifySkipped: boolean;
  verified: boolean;
  verifyDurationMs?: number;
  verifyError?: string;
  /**
   * Classified remediation hint for the verify failure. Replaces the old
   * `verifyAuthLike: boolean` which conflated auth/rate-limit/version errors
   * into a single bucket and produced misleading "→ auth: …" CTAs for
   * rate-limited harnesses. Values: `auth` (re-login), `rate_limit` (wait),
   * `version` (upgrade). Undefined when the error doesn't match any
   * classifier — the renderer falls through to a generic `→ debug: …` CTA.
   */
  verifyHint?: VerifyHint;
  authCommand: string;
  /** True iff installed and (verified or verifySkipped). */
  ready: boolean;
}

export interface OnboardOptions {
  /** Restrict to a subset of harnesses. Defaults to all five (HARNESS_SPECS). */
  harnesses?: HarnessId[];
  /** Try `npm install -g <pkg>@latest` for harnesses that need it. */
  install?: boolean;
  /** Skip the verification dispatch (default: do it). */
  noVerify?: boolean;
  /** Path to config.yaml. Falls back to auto-detect. */
  configPath?: string;
  /** Override for testing — bypasses real subprocess work. */
  hooks?: OnboardHooks;
}

/** Test seam: the four pieces that touch the host. */
export interface OnboardHooks {
  whichOf?(command: string): Promise<string | null>;
  runVersion?(command: string, versionArg: string): Promise<string | undefined>;
  fetchLatest?(npmPackage: string): Promise<string | undefined>;
  install?(npmPackage: string): Promise<{ ok: boolean; needsAdmin?: boolean; error?: string }>;
  verify?(harness: HarnessId): Promise<{ ok: boolean; durationMs: number; error?: string }>;
}

// ---------------------------------------------------------------------------
// Default hook implementations (real I/O)
// ---------------------------------------------------------------------------

async function defaultWhichOf(command: string): Promise<string | null> {
  try {
    return await which(command);
  } catch {
    return null;
  }
}

const VERSION_RE = /(\d+\.\d+(?:\.\d+)?)/;

/**
 * Cross-platform spawn that handles Windows `.cmd` / `.bat` shims without
 * `shell: true` (which trips Node's DEP0190 security warning). On Windows
 * we route through `%ComSpec% /c <cmd>`; on Unix we spawn directly.
 *
 * Inputs come from a static HARNESS_SPECS table + npm package names — no
 * user-supplied strings — so the lack of arg escaping is safe here.
 */
function spawnCross(command: string, args: string[]) {
  if (process.platform === "win32") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    return spawn(shell, ["/c", command, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
}

async function defaultRunVersion(command: string, versionArg: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawnCross(command, [versionArg]);
    let buf = "";
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      buf += b.toString();
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, 5000);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
    child.on("close", () => {
      clearTimeout(timeout);
      const match = VERSION_RE.exec(buf);
      resolve(match ? match[1] : undefined);
    });
  });
}

async function defaultFetchLatest(npmPackage: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawnCross("npm", ["view", npmPackage, "version"]);
    let buf = "";
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString();
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, 8000);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return resolve(undefined);
      const v = buf.trim();
      resolve(v || undefined);
    });
  });
}

const ADMIN_PATTERNS = [
  /EACCES/i,
  /EPERM/i,
  /permission denied/i,
  /operation not permitted/i,
  /access is denied/i,
  /requires administrator/i,
];

function looksLikeAdminError(text: string): boolean {
  return ADMIN_PATTERNS.some((re) => re.test(text));
}

async function defaultInstall(
  npmPackage: string,
): Promise<{ ok: boolean; needsAdmin?: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawnCross("npm", ["install", "-g", `${npmPackage}@latest`]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, error: "npm install timed out after 120s" });
    }, 120_000);
    child.on("error", (err) => {
      clearTimeout(timeout);
      const msg = err.message || String(err);
      resolve({ ok: false, needsAdmin: looksLikeAdminError(msg), error: msg });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) return resolve({ ok: true });
      const combined = `${stdout}\n${stderr}`;
      const trimmedErr = stderr.trim() || stdout.trim() || `npm exited with code ${code}`;
      resolve({
        ok: false,
        needsAdmin: looksLikeAdminError(combined),
        error: trimmedErr.split("\n").slice(0, 5).join("\n"),
      });
    });
  });
}

// Auth-like error classifier.
//
// History: this list previously included `/\b401\b/`, `/\b403\b/`,
// `/sign[ -]?in/i`, and `/requires.{0,10}newer.{0,10}version/i` — every one
// of which produced false positives. Bare `\b401\b` matches timestamps and
// log-line prefixes; `sign in` matches dashboard promo text; the version
// pattern was for upgrade errors entirely (now lives in VERSION_PATTERNS).
//
// New rule: each pattern must encode a clear *auth-required* phrasing. HTTP
// status codes only count when prefixed by "HTTP" or "Status:" so we don't
// catch IDs and timestamps. We also classify rate-limit errors first
// (looksLikeRateLimitError takes precedence) so a "401" inside a rate-limit
// payload doesn't get mis-tagged.
const AUTH_PATTERNS = [
  /not.{0,20}auth/i,
  /unauth/i,
  /invalid[_ -]?token/i,
  /AuthRequired/i,
  /token is not authorized/i,
  /please.{0,10}log[ -]?in/i,
  /please.{0,10}sign[ -]?in/i, // narrower than the old bare /sign[ -]?in/i
  /\bHTTP\s+401\b/i,
  /\bHTTP\s+403\b/i,
  /\bStatus:?\s*401\b/i,
  /\bStatus:?\s*403\b/i,
  /OAuth.{0,30}(expired|invalid|required)/i,
  /credentials?.{0,30}(expired|invalid|missing)/i,
];

// Version-mismatch / upgrade-required classifier. These were previously
// (incorrectly) lumped under AUTH_PATTERNS because of the
// `/requires…newer…version/i` regex.
const VERSION_PATTERNS = [
  /requires.{0,10}newer.{0,10}version/i,
  /update.{0,10}required/i,
  /upgrade.{0,10}required/i,
  /unsupported.{0,10}version/i,
  /version.{0,10}too.{0,10}old/i,
  /please.{0,10}upgrade/i,
];

function looksLikeAuthError(text: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(text));
}

function looksLikeVersionError(text: string): boolean {
  return VERSION_PATTERNS.some((re) => re.test(text));
}

/** Discriminator for verify-failure remediation hints. */
export type VerifyHint = "auth" | "rate_limit" | "version";

/**
 * Classify a verify-step error into one of three remediation buckets.
 * Order matters: rate-limit wins over auth, since 5h-quota errors often
 * include "401" or "sign in to upgrade" copy that would otherwise
 * mis-tag as auth.
 */
function classifyVerifyError(text: string): VerifyHint | undefined {
  // Rate-limit detection lives in the dispatchers/shared helper to keep
  // CLI-text scanning logic in one place — same scan the dispatchers use.
  if (detectRateLimitInText(text).rateLimited) return "rate_limit";
  if (looksLikeVersionError(text)) return "version";
  if (looksLikeAuthError(text)) return "auth";
  return undefined;
}

/**
 * Pick the most informative line from a multi-line error for terse display.
 * Codex (and others) emit informational log lines first ("Reading additional
 * input from stdin..."), with the actual diagnostic at the end. The previous
 * truncate-from-the-front approach hid every real error. We look for the
 * last non-empty line that doesn't look like a stdin/connecting/spinner
 * informational marker; if all lines look informational we fall back to the
 * last non-empty line.
 *
 * Exported for testing. The classifier is stable enough that breakage here
 * would silently shift CTAs, so it's worth direct test coverage.
 */
const INFO_LINE_RE =
  /^(\s*)(\[\d+\]\s+)?(Reading additional input|Connecting|Loading|Starting|Initializing|Resolving|Configuring)/i;
export function pickDiagnosticLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return text.trim();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!INFO_LINE_RE.test(line)) return line;
  }
  return lines[lines.length - 1]!;
}

/**
 * Discover generic_cli services from config and synthesize a HarnessSpec
 * for each. Lets the onboarding probe treat user-defined CLIs the same
 * way it treats the 6 built-in harnesses — install / verify / ready — and
 * surface the recipe's `authCommand` as the auth-CTA hint.
 *
 * If config loading fails (missing file, parse error, transient I/O), we
 * return [] so the built-in probes still run. Onboarding is best-effort by
 * design; a malformed user config shouldn't block diagnostic output for
 * the built-ins.
 */
async function loadGenericCliSpecs(configPath: string | undefined): Promise<HarnessSpec[]> {
  let config: RouterConfig;
  try {
    config = await loadConfig(configPath);
  } catch {
    return [];
  }
  const out: HarnessSpec[] = [];
  for (const [name, svc] of Object.entries(config.services)) {
    if (svc.type !== "generic_cli") continue;
    if (!svc.enabled) continue;
    if (!svc.command) continue; // already validated by the dispatcher; defensive
    const harness = svc.harness ?? name;
    // Don't shadow a built-in. If a user names a generic_cli service the
    // same as a built-in harness id, prefer the built-in (which has fuller
    // metadata — npmPackage, installUrl, etc.).
    if ((BUILTIN_HARNESS_IDS as readonly string[]).includes(harness)) continue;
    const spec: HarnessSpec = {
      harness,
      displayName: name,
      command: svc.command,
      versionArg: "--version",
      authCommand: svc.genericCli?.authCommand ?? `${svc.command} auth login`,
    };
    out.push(spec);
  }
  return out;
}

async function defaultVerify(
  harness: HarnessId,
  configPath: string | undefined,
): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  const config: RouterConfig = await loadConfig(configPath);
  const dispatchers = await buildDispatchers(config);

  // Pick the first enabled service whose harness (resolved as svc.harness ?? name)
  // matches the requested harness id.
  let dispatcher: Dispatcher | undefined;
  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.enabled) continue;
    const h = svc.harness ?? name;
    if (h === harness && dispatchers[name]) {
      dispatcher = dispatchers[name];
      break;
    }
  }
  if (!dispatcher) {
    return {
      ok: false,
      durationMs: 0,
      error: `no enabled ${harness} service in config (verify needs at least one).`,
    };
  }

  const t0 = Date.now();
  try {
    const result = await dispatcher.dispatch(
      "Reply with only the single word: ok",
      [],
      process.cwd(),
      { timeoutMs: 60_000 },
    );
    const durationMs = Date.now() - t0;
    if (result.success && (result.output ?? "").length > 0) {
      return { ok: true, durationMs };
    }
    return {
      ok: false,
      durationMs,
      error: result.error ?? `dispatch returned success=${result.success} with empty output`,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    return {
      ok: false,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Public orchestrator
// ---------------------------------------------------------------------------

export async function onboard(opts: OnboardOptions = {}): Promise<HarnessReport[]> {
  // Discover any generic_cli services declared in config and synthesize
  // HarnessSpecs for them. They share the same install/verify/ready probe
  // as the built-in harnesses, get their own row in the `init` checklist,
  // and surface their `auth_command` recipe field as the auth CTA. Failures
  // (missing config / parse errors) degrade gracefully — we still probe
  // the 6 built-in harnesses.
  const genericSpecs = await loadGenericCliSpecs(opts.configPath);
  const allSpecs: readonly HarnessSpec[] = [...HARNESS_SPECS, ...genericSpecs];

  const targetIds = new Set<HarnessId>(opts.harnesses ?? allSpecs.map((s) => s.harness));
  const targets = allSpecs.filter((s) => targetIds.has(s.harness));
  const hooks = opts.hooks ?? {};
  const whichOf = hooks.whichOf ?? defaultWhichOf;
  const runVersion = hooks.runVersion ?? defaultRunVersion;
  const fetchLatest = hooks.fetchLatest ?? defaultFetchLatest;
  const installFn = hooks.install ?? defaultInstall;
  const verifyFn = hooks.verify ?? ((h: HarnessId) => defaultVerify(h, opts.configPath));

  const reports: HarnessReport[] = [];
  for (const spec of targets) {
    const installCommand = spec.npmPackage ? `npm install -g ${spec.npmPackage}@latest` : undefined;

    const r: HarnessReport = {
      harness: spec.harness,
      displayName: spec.displayName,
      installed: false,
      upgradeAvailable: false,
      installAttempted: false,
      verifySkipped: !!opts.noVerify,
      verified: false,
      authCommand: spec.authCommand,
      ready: false,
    };
    if (spec.npmPackage) r.npmPackage = spec.npmPackage;
    if (spec.installNotes) r.installNotes = spec.installNotes;
    if (spec.installUrl) r.installUrl = spec.installUrl;
    if (installCommand) r.installCommand = installCommand;

    // 1. installed?
    const path = await whichOf(spec.command);
    r.installed = path !== null;
    if (r.installed) {
      const v = await runVersion(spec.command, spec.versionArg);
      if (v) r.installedVersion = v;
    }

    // 2. latest version (if applicable)
    if (spec.npmPackage) {
      const latest = await fetchLatest(spec.npmPackage);
      if (latest) r.latestVersion = latest;
      if (latest && r.installedVersion) {
        r.upgradeAvailable = compareVersions(r.installedVersion, latest) < 0;
      }
    }

    // 3. install if requested and applicable
    if (opts.install && spec.npmPackage && (!r.installed || r.upgradeAvailable)) {
      r.installAttempted = true;
      const result = await installFn(spec.npmPackage);
      r.installResult = result;
      if (result.ok) {
        // Re-check after install.
        const pathAfter = await whichOf(spec.command);
        r.installed = pathAfter !== null;
        if (r.installed) {
          const vAfter = await runVersion(spec.command, spec.versionArg);
          if (vAfter) r.installedVersion = vAfter;
          r.upgradeAvailable = false;
        }
      }
    }

    // 4. verify (if installed and not skipped)
    if (r.installed && !opts.noVerify) {
      const v = await verifyFn(spec.harness);
      r.verifyDurationMs = v.durationMs;
      r.verified = v.ok;
      if (!v.ok) {
        if (v.error !== undefined) {
          r.verifyError = v.error;
          const hint = classifyVerifyError(v.error);
          if (hint !== undefined) r.verifyHint = hint;
        }
      }
    }

    r.ready = r.installed && (opts.noVerify ? true : r.verified);
    reports.push(r);
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Version compare (semver-ish, lenient for pre-release suffixes)
// ---------------------------------------------------------------------------

export function compareVersions(a: string, b: string): number {
  const partsA = a
    .split(/[^\d]+/)
    .filter(Boolean)
    .map(Number);
  const partsB = b
    .split(/[^\d]+/)
    .filter(Boolean)
    .map(Number);
  const n = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < n; i++) {
    const x = partsA[i] ?? 0;
    const y = partsB[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Pretty renderer
// ---------------------------------------------------------------------------

const ANSI = {
  RESET: "\u001b[0m",
  DIM: "\u001b[2m",
  BOLD: "\u001b[1m",
  GREEN: "\u001b[32m",
  RED: "\u001b[31m",
  YELLOW: "\u001b[33m",
  CYAN: "\u001b[36m",
};

function paint(c: keyof typeof ANSI, s: string, on: boolean): string {
  return on ? `${ANSI[c]}${s}${ANSI.RESET}` : s;
}

export function renderReport(reports: HarnessReport[], colors: boolean): string {
  const lines: string[] = [];
  lines.push(paint("BOLD", "harness-router — onboarding stack check", colors));
  lines.push(paint("DIM", "─".repeat(54), colors));

  for (const r of reports) {
    lines.push("");
    const headLeft = paint("BOLD", r.harness, colors);
    const headRight = paint("DIM", r.displayName, colors);
    lines.push(`${headLeft}  ${headRight}`);

    // installed line
    if (r.installed) {
      let extra = "";
      if (r.installedVersion) extra += `  v${r.installedVersion}`;
      if (r.upgradeAvailable && r.latestVersion) {
        extra += paint("YELLOW", `  ⚠ latest ${r.latestVersion}`, colors);
      }
      lines.push(`  ${paint("GREEN", "✓", colors)} installed${extra}`);
    } else {
      lines.push(`  ${paint("RED", "✗", colors)} installed    not found on PATH`);
    }

    // verified line
    if (r.verifySkipped) {
      lines.push(`  ${paint("DIM", "─", colors)} verified     skipped (--no-verify)`);
    } else if (!r.installed) {
      lines.push(`  ${paint("DIM", "─", colors)} verified     skipped (not installed)`);
    } else if (r.verified) {
      const dur =
        r.verifyDurationMs !== undefined ? ` in ${(r.verifyDurationMs / 1000).toFixed(1)}s` : "";
      lines.push(`  ${paint("GREEN", "✓", colors)} verified     "ok"${dur}`);
    } else {
      lines.push(
        `  ${paint("RED", "✗", colors)} verified     ${truncate(r.verifyError ?? "unknown error", 60)}`,
      );
    }

    // install attempt feedback
    if (r.installAttempted && r.installResult) {
      if (r.installResult.ok) {
        lines.push(
          `  ${paint("GREEN", "✓", colors)} install      ran  npm install -g ${r.npmPackage}@latest`,
        );
      } else if (r.installResult.needsAdmin) {
        lines.push(`  ${paint("YELLOW", "⚠", colors)} install      needs elevated shell`);
      } else {
        lines.push(
          `  ${paint("RED", "✗", colors)} install      ${truncate(r.installResult.error ?? "failed", 60)}`,
        );
      }
    }

    // next-step suggestions
    const nexts: string[] = [];
    if (!r.installed) {
      if (r.installCommand) {
        nexts.push(`run (admin): ${paint("CYAN", r.installCommand, colors)}`);
      } else if (r.installUrl) {
        nexts.push(
          `download: ${paint("CYAN", r.installUrl, colors)}${r.installNotes ? `  (${r.installNotes})` : ""}`,
        );
      }
    } else if (r.upgradeAvailable && !r.installAttempted && r.installCommand) {
      nexts.push(`upgrade (admin): ${paint("CYAN", r.installCommand, colors)}`);
    } else if (r.installAttempted && r.installResult?.needsAdmin && r.installCommand) {
      nexts.push(`re-run from elevated shell: ${paint("CYAN", r.installCommand, colors)}`);
    }
    if (r.verifyError && r.installed) {
      // Three-way CTA: each verify-failure class gets its correct
      // remediation. The `pickDiagnosticLine` helper extracts the actual
      // diagnostic from multi-line errors (codex etc. emit informational
      // log lines first; the original truncate-from-front would cut off
      // before the real error).
      const diag = pickDiagnosticLine(r.verifyError);
      switch (r.verifyHint) {
        case "auth":
          nexts.push(`auth: ${paint("CYAN", r.authCommand, colors)}`);
          break;
        case "rate_limit":
          nexts.push(`rate-limited — wait then retry: ${paint("DIM", truncate(diag, 80), colors)}`);
          break;
        case "version":
          if (r.installCommand) {
            nexts.push(`upgrade (admin): ${paint("CYAN", r.installCommand, colors)}`);
          } else {
            nexts.push(`upgrade required: ${paint("DIM", truncate(diag, 80), colors)}`);
          }
          break;
        default:
          nexts.push(`debug: ${paint("DIM", truncate(diag, 80), colors)}`);
          break;
      }
    }
    for (const next of nexts) {
      lines.push(`  ${paint("CYAN", "→", colors)} ${next}`);
    }

    // overall ready summary line
    if (r.ready) {
      lines.push(`  ${paint("DIM", "─ ready", colors)}`);
    }
  }

  lines.push("");
  lines.push(paint("DIM", "─".repeat(54), colors));
  const ready = reports.filter((r) => r.ready).length;
  const summary = `${ready}/${reports.length} harnesses ready`;
  lines.push(paint("BOLD", summary, colors));
  if (ready < reports.length) {
    lines.push(
      paint("DIM", "Re-run `harness-router doctor` after applying the next-step commands.", colors),
    );
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}
