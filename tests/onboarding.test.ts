/**
 * Unit tests for src/onboarding.ts.
 *
 * The orchestrator is exercised through its `hooks` test seam — every piece
 * that touches the host (which / version probe / npm registry / install /
 * dispatcher.dispatch) is replaced with a deterministic stub so these tests
 * never spawn a real subprocess.
 */

import { describe, expect, it } from "vitest";

import {
  HARNESS_SPECS,
  compareVersions,
  onboard,
  pickDiagnosticLine,
  renderReport,
  type HarnessId,
  type OnboardHooks,
} from "../src/onboarding.js";

// ---------------------------------------------------------------------------
// Hook builders
// ---------------------------------------------------------------------------

interface FakeWorld {
  installed: Partial<Record<string, string | null>>; // command -> version on PATH ("null" = missing)
  latest: Partial<Record<string, string>>; // npm package -> latest
  verifyResults: Partial<Record<HarnessId, { ok: boolean; durationMs: number; error?: string }>>;
  installResults?: Partial<Record<string, { ok: boolean; needsAdmin?: boolean; error?: string }>>;
}

function hooksFrom(world: FakeWorld): OnboardHooks {
  return {
    async whichOf(command) {
      const v = world.installed[command];
      return v === null || v === undefined ? null : `/fake/path/${command}`;
    },
    async runVersion(command) {
      const v = world.installed[command];
      return typeof v === "string" ? v : undefined;
    },
    async fetchLatest(npmPackage) {
      return world.latest[npmPackage];
    },
    async install(npmPackage) {
      const r = world.installResults?.[npmPackage];
      return r ?? { ok: true };
    },
    async verify(harness) {
      const r = world.verifyResults[harness];
      return r ?? { ok: true, durationMs: 100 };
    },
  };
}

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

describe("compareVersions", () => {
  it("returns < 0 when a is older", () => {
    expect(compareVersions("0.77.0", "0.125.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.9.0", "2.0.0")).toBeLessThan(0);
  });

  it("returns 0 on equal versions", () => {
    expect(compareVersions("3.1.4", "3.1.4")).toBe(0);
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
  });

  it("returns > 0 when a is newer", () => {
    expect(compareVersions("0.125.0", "0.77.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
  });

  it("treats missing trailing components as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("2.0", "2.0.1")).toBeLessThan(0);
  });

  it("ignores non-numeric suffixes", () => {
    expect(compareVersions("1.2.3-beta", "1.2.3")).toBe(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// onboard()
// ---------------------------------------------------------------------------

describe("onboard()", () => {
  it("reports ready=true when every harness is installed and verified", async () => {
    const reports = await onboard({
      hooks: hooksFrom({
        installed: {
          claude: "1.0.0",
          codex: "0.125.0",
          agent: "1.0.0",
          gemini: "3.0.0",
          opencode: "1.0.0",
          copilot: "1.0.0",
        },
        latest: {
          "@anthropic-ai/claude-code": "1.0.0",
          "@openai/codex": "0.125.0",
          "@google/gemini-cli": "3.0.0",
        },
        verifyResults: {},
      }),
    });
    expect(reports).toHaveLength(HARNESS_SPECS.length);
    for (const r of reports) {
      expect(r.installed).toBe(true);
      expect(r.verified).toBe(true);
      expect(r.ready).toBe(true);
      expect(r.upgradeAvailable).toBe(false);
    }
  });

  it("flags missing CLIs with the right install path per harness", async () => {
    const reports = await onboard({
      hooks: hooksFrom({
        installed: {
          claude: null,
          codex: null,
          agent: null,
          gemini: null,
          opencode: null,
          copilot: null,
        },
        latest: {
          "@anthropic-ai/claude-code": "1.0.0",
          "@openai/codex": "0.125.0",
          "@google/gemini-cli": "3.0.0",
        },
        verifyResults: {},
      }),
    });
    const byHarness = Object.fromEntries(reports.map((r) => [r.harness, r]));

    // Five of six are npm-installable.
    expect(byHarness.claude_code!.installCommand).toBe(
      "npm install -g @anthropic-ai/claude-code@latest",
    );
    expect(byHarness.codex!.installCommand).toBe("npm install -g @openai/codex@latest");
    expect(byHarness.gemini_cli!.installCommand).toBe("npm install -g @google/gemini-cli@latest");
    expect(byHarness.opencode!.installCommand).toBe("npm install -g opencode-ai@latest");
    expect(byHarness.copilot!.installCommand).toBe("npm install -g @github/copilot@latest");

    // Cursor is the structural outlier: download URL, no install command.
    expect(byHarness.cursor!.installCommand).toBeUndefined();
    expect(byHarness.cursor!.installUrl).toBe("https://cursor.com/download");
    expect(byHarness.cursor!.installNotes).toMatch(/desktop app/i);

    for (const r of reports) {
      expect(r.installed).toBe(false);
      expect(r.verified).toBe(false);
      expect(r.ready).toBe(false);
    }
  });

  it("marks upgradeAvailable when installed < latest", async () => {
    const reports = await onboard({
      hooks: hooksFrom({
        installed: { claude: "1.0.0", codex: "0.77.0", agent: "1.0.0", gemini: "3.0.0" },
        latest: {
          "@anthropic-ai/claude-code": "1.0.0",
          "@openai/codex": "0.125.0",
          "@google/gemini-cli": "3.0.0",
        },
        verifyResults: {},
      }),
    });
    const codex = reports.find((r) => r.harness === "codex")!;
    expect(codex.installedVersion).toBe("0.77.0");
    expect(codex.latestVersion).toBe("0.125.0");
    expect(codex.upgradeAvailable).toBe(true);

    const claude = reports.find((r) => r.harness === "claude_code")!;
    expect(claude.upgradeAvailable).toBe(false);
  });

  it("captures verify errors and classifies them (auth | rate_limit | version | none)", async () => {
    const reports = await onboard({
      hooks: hooksFrom({
        installed: {
          claude: "1.0.0",
          codex: "0.125.0",
          agent: "1.0.0",
          gemini: "3.0.0",
          opencode: "1.0.0",
          copilot: "1.0.0",
        },
        latest: {
          "@anthropic-ai/claude-code": "1.0.0",
          "@openai/codex": "0.125.0",
          "@google/gemini-cli": "3.0.0",
        },
        verifyResults: {
          // Auth: clear "AuthRequired" phrasing.
          claude_code: {
            ok: false,
            durationMs: 500,
            error: "AuthRequired: Token is not authorized",
          },
          // Rate-limit: was previously misclassified as auth because the
          // old patterns matched bare "401" or "sign in" keywords. Now the
          // shared rate-limit detector wins first.
          codex: {
            ok: false,
            durationMs: 500,
            error: "Error: rate limit exceeded for 5h window. retry-after: 90",
          },
          // Generic / unknown: should fall through to no hint.
          gemini_cli: { ok: false, durationMs: 200, error: "subprocess crashed: ENOENT" },
          // Version mismatch: tests that VERSION_PATTERNS no longer leak
          // into AUTH_PATTERNS (the old `requires…newer…version` regex
          // lived under AUTH for no reason).
          cursor: {
            ok: false,
            durationMs: 200,
            error: "this build requires a newer version of macOS",
          },
        },
      }),
    });
    const claude = reports.find((r) => r.harness === "claude_code")!;
    expect(claude.verifyHint).toBe("auth");
    expect(claude.verifyError).toContain("AuthRequired");

    const codex = reports.find((r) => r.harness === "codex")!;
    expect(codex.verifyHint).toBe("rate_limit");

    const gemini = reports.find((r) => r.harness === "gemini_cli")!;
    expect(gemini.verifyHint).toBeUndefined();

    const cursor = reports.find((r) => r.harness === "cursor")!;
    expect(cursor.verifyHint).toBe("version");
  });

  it("classifies anchored HTTP/Status 4xx phrasings as auth (audit B: WEAK-4)", async () => {
    // The previous AUTH_PATTERNS used bare /\b401\b/ which matched
    // timestamps and log line numbers. The fix anchors to "HTTP 401",
    // "Status: 401", "OAuth … expired", "credentials expired/invalid",
    // etc. This test exercises every anchored pattern explicitly so a
    // future loosening doesn't regress.
    const cases: Array<{ harness: HarnessId; error: string }> = [
      { harness: "claude_code", error: "Error: HTTP 401 unauthorized" },
      { harness: "codex", error: "Status: 403 forbidden" },
      { harness: "cursor", error: "Error: OAuth token expired, please re-auth" },
      { harness: "gemini_cli", error: "Error: credentials are invalid for this account" },
    ];
    const verifyResults: Partial<
      Record<HarnessId, { ok: boolean; durationMs: number; error: string }>
    > = {};
    for (const c of cases) {
      verifyResults[c.harness] = { ok: false, durationMs: 100, error: c.error };
    }
    const reports = await onboard({
      hooks: hooksFrom({
        installed: {
          claude: "1.0.0",
          codex: "0.125.0",
          agent: "1.0.0",
          gemini: "3.0.0",
          opencode: "1.0.0",
          copilot: "1.0.0",
        },
        latest: {},
        verifyResults,
      }),
    });
    for (const c of cases) {
      const r = reports.find((rep) => rep.harness === c.harness)!;
      expect(r.verifyHint, `case: ${c.error}`).toBe("auth");
    }
  });

  it("does NOT classify a bare '401' inside a longer log line as auth (regression)", async () => {
    // The old /\b401\b/ regex would have flagged this; the new anchored
    // pattern requires HTTP/Status context.
    const reports = await onboard({
      hooks: hooksFrom({
        installed: {
          claude: "1.0.0",
          codex: "0.125.0",
          agent: "1.0.0",
          gemini: "3.0.0",
          opencode: "1.0.0",
          copilot: "1.0.0",
        },
        latest: {},
        verifyResults: {
          claude_code: {
            ok: false,
            durationMs: 100,
            error: "request_id=4011a2b: subprocess crashed",
          },
        },
      }),
    });
    const r = reports.find((rep) => rep.harness === "claude_code")!;
    expect(r.verifyHint).toBeUndefined();
  });

  it("skips verify when noVerify is set; ready=installed", async () => {
    const reports = await onboard({
      noVerify: true,
      hooks: hooksFrom({
        installed: {
          claude: "1.0.0",
          codex: "0.125.0",
          agent: "1.0.0",
          gemini: "3.0.0",
          opencode: "1.0.0",
          copilot: "1.0.0",
        },
        latest: {},
        verifyResults: {
          claude_code: { ok: false, durationMs: 0, error: "should NOT be called" },
        },
      }),
    });
    for (const r of reports) {
      expect(r.verifySkipped).toBe(true);
      expect(r.verified).toBe(false);
      expect(r.ready).toBe(true);
    }
  });

  it("includes generic_cli services in the per-harness probe (audit-driven flex)", async () => {
    // Generic CLI services declared in config should appear alongside the 5
    // built-in harnesses in the init checklist. Their `command` is probed
    // via `which`, version is probed via the same shared mechanism, and
    // verify routes through the dispatcher factory.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "onboard-generic-"));
    const configPath = path.join(tmpDir, "config.yaml");
    // v0.3 config shape — generic_cli harness lives under a model entry's
    // subscription route. The onboard probe still discovers the harness id
    // and surfaces the auth_command from generic_cli.auth_command.
    await fs.writeFile(
      configPath,
      [
        "priority: [custom-model]",
        "models:",
        "  custom-model:",
        "    subscription:",
        "      harness: my_custom",
        "      command: my-cli",
        "      generic_cli:",
        "        auth_command: 'my-cli auth login'",
      ].join("\n"),
      "utf8",
    );

    const reports = await onboard({
      configPath,
      hooks: hooksFrom({
        installed: {
          claude: "1.0.0",
          codex: "0.125.0",
          agent: "1.0.0",
          gemini: "3.0.0",
          opencode: "1.0.0",
          copilot: "1.0.0",
          "my-cli": "1.0.0",
        },
        latest: {},
        verifyResults: {},
      }),
    });
    const custom = reports.find((r) => r.harness === "my_custom");
    expect(custom).toBeDefined();
    expect(custom!.installed).toBe(true);
    expect(custom!.authCommand).toBe("my-cli auth login");
  });

  it("respects a harnesses filter", async () => {
    const reports = await onboard({
      harnesses: ["codex"],
      hooks: hooksFrom({
        installed: { codex: "0.125.0" },
        latest: { "@openai/codex": "0.125.0" },
        verifyResults: {},
      }),
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.harness).toBe("codex");
  });

  it("when install=true, runs install for missing/upgradable npm packages and re-detects", async () => {
    const calls: string[] = [];
    const world: FakeWorld = {
      // claude missing, codex outdated, gemini at latest, opencode at latest, cursor missing.
      installed: {
        claude: null,
        codex: "0.77.0",
        agent: null,
        gemini: "3.0.0",
        opencode: "1.0.0",
        copilot: "1.0.0",
      },
      latest: {
        "@anthropic-ai/claude-code": "1.0.0",
        "@openai/codex": "0.125.0",
        "@google/gemini-cli": "3.0.0",
        "opencode-ai": "1.0.0",
      },
      verifyResults: {},
    };
    const hooks: OnboardHooks = {
      ...hooksFrom(world),
      async install(pkg) {
        calls.push(pkg);
        // Simulate a successful install: the world now has the binary at @latest.
        if (pkg === "@anthropic-ai/claude-code") world.installed.claude = "1.0.0";
        if (pkg === "@openai/codex") world.installed.codex = "0.125.0";
        return { ok: true };
      },
    };
    const reports = await onboard({ install: true, hooks });
    // Cursor has no npm package — never installed.
    // Gemini and opencode were already at latest — no install attempt.
    expect(calls.sort()).toEqual(["@anthropic-ai/claude-code", "@openai/codex"]);

    const claude = reports.find((r) => r.harness === "claude_code")!;
    expect(claude.installAttempted).toBe(true);
    expect(claude.installResult?.ok).toBe(true);
    expect(claude.installed).toBe(true);
    expect(claude.installedVersion).toBe("1.0.0");

    const codex = reports.find((r) => r.harness === "codex")!;
    expect(codex.installAttempted).toBe(true);
    expect(codex.installedVersion).toBe("0.125.0");
    expect(codex.upgradeAvailable).toBe(false);

    const gemini = reports.find((r) => r.harness === "gemini_cli")!;
    expect(gemini.installAttempted).toBe(false);
  });

  it("surfaces needsAdmin when the install hook reports it", async () => {
    const reports = await onboard({
      install: true,
      hooks: {
        ...hooksFrom({
          installed: {
            claude: null,
            codex: "0.125.0",
            agent: "1.0.0",
            gemini: "3.0.0",
            opencode: "1.0.0",
            copilot: "1.0.0",
          },
          latest: {
            "@anthropic-ai/claude-code": "1.0.0",
            "@openai/codex": "0.125.0",
            "@google/gemini-cli": "3.0.0",
            "opencode-ai": "1.0.0",
          },
          verifyResults: {},
        }),
        async install() {
          return { ok: false, needsAdmin: true, error: "EPERM: operation not permitted" };
        },
      },
    });
    const claude = reports.find((r) => r.harness === "claude_code")!;
    expect(claude.installAttempted).toBe(true);
    expect(claude.installResult?.ok).toBe(false);
    expect(claude.installResult?.needsAdmin).toBe(true);
    expect(claude.installed).toBe(false);
    expect(claude.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pickDiagnosticLine — extracts the actual error line from multi-line CLI
// output, skipping informational headers like "Reading additional input...".
// ---------------------------------------------------------------------------

describe("pickDiagnosticLine", () => {
  it("returns the only line of a single-line error", () => {
    expect(pickDiagnosticLine("HTTP 401 unauthorized")).toBe("HTTP 401 unauthorized");
  });

  it("returns the trimmed input when there are no non-empty lines", () => {
    expect(pickDiagnosticLine("")).toBe("");
    expect(pickDiagnosticLine("\n\n  \n\n")).toBe("");
  });

  it("strips trailing blank lines and surrounding whitespace", () => {
    const text = "Error: rate limit exceeded\n\n   \n";
    expect(pickDiagnosticLine(text)).toBe("Error: rate limit exceeded");
  });

  it("skips informational prefix lines and returns the real diagnostic", () => {
    // The codex shape that prompted the helper's existence.
    const text = [
      "Reading additional input from stdin...",
      "2026-04-29T23:38:07.123Z INFO codex_core: starting",
      "Error: 5h usage limit exceeded. retry-after: 90",
    ].join("\n");
    expect(pickDiagnosticLine(text)).toMatch(/5h usage limit/);
  });

  it("falls back to the last line when EVERY line looks informational", () => {
    // The fallback should still produce something usable rather than empty.
    const text = ["Reading additional input from stdin...", "Loading config..."].join("\n");
    expect(pickDiagnosticLine(text)).toBe("Loading config...");
  });

  it("does NOT treat 'Loading config failed' as informational (matches the suffix-after-prefix)", () => {
    // The prefix list is intentionally aggressive but the regex only matches
    // the START of a line. "Loading" alone matches; "Loading config failed:
    // ENOENT" also matches because INFO_LINE_RE only checks the prefix word.
    // The fallback path then picks this up as the last line. We document the
    // behaviour with a test rather than try to make the prefix list smarter
    // — it's a heuristic and "make the failure less noisy" is more important
    // than "perfectly classify every shape."
    const text = "Loading config failed: ENOENT";
    // Single line → no informational alternative → falls back to itself.
    expect(pickDiagnosticLine(text)).toBe("Loading config failed: ENOENT");
  });

  it("handles CRLF line endings (Windows codex stderr)", () => {
    const text = "Reading additional input from stdin...\r\nError: real failure here";
    expect(pickDiagnosticLine(text)).toBe("Error: real failure here");
  });

  it("treats indented informational prefixes as informational", () => {
    // Some CLIs indent their log output. The regex allows leading whitespace.
    const text = ["    Connecting to provider...", "auth required"].join("\n");
    expect(pickDiagnosticLine(text)).toBe("auth required");
  });
});

// ---------------------------------------------------------------------------
// renderReport — keep the snapshot loose; we care about specific markers.
// ---------------------------------------------------------------------------

describe("renderReport", () => {
  it("includes install/upgrade/auth next-step markers in the no-color output", async () => {
    const reports = await onboard({
      hooks: hooksFrom({
        installed: { claude: "1.0.0", codex: "0.77.0", agent: null, gemini: "3.0.0" },
        latest: {
          "@anthropic-ai/claude-code": "1.0.0",
          "@openai/codex": "0.125.0",
          "@google/gemini-cli": "3.0.0",
        },
        verifyResults: {
          codex: { ok: false, durationMs: 100, error: "AuthRequired: invalid_token" },
        },
      }),
    });
    const out = renderReport(reports, false);

    // claude_code happy path
    expect(out).toContain("claude_code");
    expect(out).toMatch(/✓ installed.*1\.0\.0/);

    // codex upgrade hint + auth prescription
    expect(out).toContain("⚠ latest 0.125.0");
    expect(out).toContain("upgrade (admin): npm install -g @openai/codex@latest");
    expect(out).toContain("auth: codex auth login");

    // cursor download URL
    expect(out).toContain("download: https://cursor.com/download");
    expect(out).toMatch(/desktop app/i);

    // summary tally — match the count generated by HARNESS_SPECS so this
    // doesn't break each time a built-in is added.
    expect(out).toMatch(new RegExp(`\\d/${HARNESS_SPECS.length} harnesses ready`));
  });

  it("renders an upgrade CTA when the verify error matches a version-mismatch pattern", async () => {
    const reports = await onboard({
      hooks: hooksFrom({
        installed: {
          claude: "1.0.0",
          codex: "0.125.0",
          agent: "1.0.0",
          gemini: "3.0.0",
          opencode: "1.0.0",
          copilot: "1.0.0",
        },
        latest: {
          "@anthropic-ai/claude-code": "1.0.0",
          "@openai/codex": "0.125.0",
          "@google/gemini-cli": "3.0.0",
        },
        verifyResults: {
          // Has installCommand → "upgrade (admin): npm install …"
          claude_code: {
            ok: false,
            durationMs: 100,
            error: "Error: this build requires a newer version of the SDK",
          },
          // No installCommand (Cursor is desktop-app) → "upgrade required: <diag>"
          cursor: {
            ok: false,
            durationMs: 100,
            error: "agent: please upgrade to a newer build (1.0.5+)",
          },
        },
      }),
    });
    const out = renderReport(reports, false);
    // Both rendering paths should produce upgrade-flavoured CTAs.
    expect(out).toContain("upgrade (admin): npm install -g @anthropic-ai/claude-code@latest");
    expect(out).toContain("upgrade required:");
    // And neither should fall through to the auth or rate-limit CTA.
    expect(out).not.toMatch(/auth: claude auth login/);
    expect(out).not.toMatch(/rate-limited/);
  });

  it("renders a rate-limit CTA (not auth) when the verify error matches rate-limit signals", async () => {
    // Regression: codex's 5h-quota error was previously misclassified as auth
    // because the legacy looksLikeAuthError matched bare "401" / "sign in"
    // keywords. The new classifier prioritises rate-limit so we get the
    // correct CTA — the user should be told to wait, not to re-login.
    const reports = await onboard({
      hooks: hooksFrom({
        installed: {
          claude: "1.0.0",
          codex: "0.125.0",
          agent: "1.0.0",
          gemini: "3.0.0",
          opencode: "1.0.0",
          copilot: "1.0.0",
        },
        latest: {},
        verifyResults: {
          codex: {
            ok: false,
            durationMs: 100,
            error:
              "Reading additional input from stdin...\nError: rate limit exceeded. retry-after: 60",
          },
        },
      }),
    });
    const out = renderReport(reports, false);
    expect(out).toContain("rate-limited");
    // Diagnostic-line picker should surface the actual error, not the
    // informational "Reading additional input from stdin..." prefix that
    // the old truncate-from-front logic would have shown.
    expect(out).toContain("rate limit exceeded");
    expect(out).not.toMatch(/→ auth: codex auth login/);
  });

  it("emits ANSI codes only when colors are enabled", async () => {
    const reports = await onboard({
      hooks: hooksFrom({
        installed: {
          claude: "1.0.0",
          codex: "0.125.0",
          agent: "1.0.0",
          gemini: "3.0.0",
          opencode: "1.0.0",
          copilot: "1.0.0",
        },
        latest: {},
        verifyResults: {},
      }),
    });
    const colored = renderReport(reports, true);
    const plain = renderReport(reports, false);
    // Require the actual ESC byte (), not just `[`. A previous
    // version of this file used embedded raw ESC bytes which display
    // tools (Read, grep, terminals) silently strip — making the source
    // and assertions look like they were missing the ESC prefix to
    // human/AI reviewers. Using the literal `` form keeps the
    // assertion legible everywhere; runtime is byte-identical.
    expect(colored).toContain("[");
    expect(plain).not.toContain("[");
  });
});
