import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type {
  SubprocessResult,
  RunSubprocessOpts,
} from "../../src/dispatchers/shared/subprocess.js";
import type { ServiceConfig } from "../../src/types.js";

vi.mock("../../src/dispatchers/shared/subprocess.js", () => ({
  runSubprocess: vi.fn(),
}));
vi.mock("../../src/dispatchers/shared/windows-cmd.js", () => ({
  resolveCliCommand: vi.fn(),
}));
vi.mock("which", () => ({
  default: vi.fn(),
}));

const { runSubprocess } = await import(
  "../../src/dispatchers/shared/subprocess.js"
);
const { resolveCliCommand } = await import(
  "../../src/dispatchers/shared/windows-cmd.js"
);
const { default: which } = await import("which");
const { GeminiDispatcher, _geminiLockIdle } = await import(
  "../../src/dispatchers/gemini.js"
);

const runSubprocessMock = runSubprocess as unknown as ReturnType<typeof vi.fn>;
const resolveCliCommandMock = resolveCliCommand as unknown as ReturnType<
  typeof vi.fn
>;
const whichMock = which as unknown as ReturnType<typeof vi.fn>;

function ok(overrides: Partial<SubprocessResult> = {}): SubprocessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 10,
    timedOut: false,
    ...overrides,
  };
}

function captureSubprocessCall(index: number): {
  command: string;
  args: string[];
  opts: RunSubprocessOpts | undefined;
} {
  const call = runSubprocessMock.mock.calls[index];
  if (!call) throw new Error(`runSubprocess call #${index} not recorded`);
  return {
    command: call[0] as string,
    args: call[1] as string[],
    opts: call[2] as RunSubprocessOpts | undefined,
  };
}

function mockFound(commandPath = "/usr/local/bin/gemini"): void {
  whichMock.mockResolvedValue(commandPath);
  resolveCliCommandMock.mockResolvedValue({
    command: commandPath,
    prefixArgs: [],
  });
}

function baseSvc(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: "gemini_cli",
    enabled: true,
    type: "cli",
    tier: 1,
    weight: 1,
    cliCapability: 1,
    escalateOn: [],
    capabilities: {},
    ...overrides,
  };
}

const savedEnv = { ...process.env };

// Use an isolated temp dir for the settings file per test-run so we never
// touch the user's real ~/.gemini/settings.json.
let tempSettingsPath: string;

beforeEach(async () => {
  runSubprocessMock.mockReset();
  resolveCliCommandMock.mockReset();
  whichMock.mockReset();

  // Drain the lock chain so prior tests' patches don't linger.
  await _geminiLockIdle();

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-test-"));
  tempSettingsPath = path.join(tmpRoot, "settings.json");
  process.env["GEMINI_SETTINGS_PATH"] = tempSettingsPath;
});

afterEach(async () => {
  await _geminiLockIdle();
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    process.env[k] = v;
  }
});

describe("GeminiDispatcher", () => {
  it("returns an error DispatchResult when the CLI is not found", async () => {
    whichMock.mockResolvedValue(null);
    const d = new GeminiDispatcher();

    const res = await d.dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.service).toBe("gemini_cli");
    expect(res.error).toMatch(/gemini CLI not found/i);
    expect(runSubprocessMock).not.toHaveBeenCalled();
  });

  it("parses the response field from JSON output", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          response: "hello world",
          usage: { input_tokens: 3, output_tokens: 5 },
        }),
      }),
    );

    const d = new GeminiDispatcher();
    const res = await d.dispatch("say hi", [], "");

    expect(res.success).toBe(true);
    expect(res.output).toBe("hello world");
    expect(res.tokensUsed).toEqual({ input: 3, output: 5 });
  });

  it("passes --model <override> through to the subprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ response: "ok" }) }),
    );

    const d = new GeminiDispatcher();
    await d.dispatch("go", [], "", { modelOverride: "gemini-3-pro" });

    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("gemini-3-pro");
  });

  it("uses the service's configured model when no override is given", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ response: "ok" }) }),
    );

    const d = new GeminiDispatcher(baseSvc({ model: "gemini-2.5-flash" }));
    await d.dispatch("go", [], "");

    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("gemini-2.5-flash");
  });

  it("passes each file via --file flag", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ response: "ok" }) }),
    );

    const d = new GeminiDispatcher();
    await d.dispatch("go", ["/a.ts", "/b.ts"], "");

    const { args } = captureSubprocessCall(0);
    const fileArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--file" && typeof args[i + 1] === "string") {
        fileArgs.push(args[i + 1] as string);
      }
    }
    expect(fileArgs).toEqual(["/a.ts", "/b.ts"]);
  });

  it("forwards GEMINI_API_KEY from process.env", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key-abc";
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ response: "ok" }) }),
    );

    const d = new GeminiDispatcher();
    await d.dispatch("go", [], "");

    const { opts } = captureSubprocessCall(0);
    expect(opts?.env?.["GEMINI_API_KEY"]).toBe("gemini-key-abc");
  });

  it("reports failure on non-zero exit code with rate-limit detection", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: "",
        stderr: "429 RESOURCE_EXHAUSTED — retry after: 12.5",
        exitCode: 1,
      }),
    );

    const d = new GeminiDispatcher();
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBe(12.5);
  });

  it("returns a timed-out DispatchResult when the subprocess times out", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: "", stderr: "", exitCode: 124, timedOut: true }),
    );

    const d = new GeminiDispatcher();
    const res = await d.dispatch("go", [], "", { timeoutMs: 50 });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timed out/i);
  });

  it("reports 'unknown' quota in R1", async () => {
    const d = new GeminiDispatcher();
    const q = await d.checkQuota();
    expect(q.service).toBe("gemini_cli");
    expect(q.source).toBe("unknown");
  });

  it("has a stable id and reports itself as available", () => {
    const d = new GeminiDispatcher();
    expect(d.id).toBe("gemini_cli");
    expect(d.isAvailable()).toBe(true);
  });

  it("writes thinkingLevel to settings.json when configured", async () => {
    mockFound();
    // Capture the settings file content at the moment the subprocess runs —
    // the dispatcher restores it afterwards, so we can't inspect it post-hoc.
    let seenContent: string | null = null;
    runSubprocessMock.mockImplementation(async () => {
      seenContent = await fs.readFile(tempSettingsPath, "utf8");
      return ok({ stdout: JSON.stringify({ response: "ok" }) });
    });

    const d = new GeminiDispatcher(baseSvc({ thinkingLevel: "high" }));
    const res = await d.dispatch("go", [], "");
    expect(res.success).toBe(true);

    expect(seenContent).not.toBeNull();
    const parsed = JSON.parse(seenContent as unknown as string) as {
      modelConfigs?: {
        generateContentConfig?: { thinkingLevel?: string };
      };
    };
    expect(
      parsed.modelConfigs?.generateContentConfig?.thinkingLevel,
    ).toBe("HIGH");
  });

  it("serialises concurrent dispatches on the module-level lock (no interleaving)", async () => {
    // Prime settings.json with a distinctive original so we can observe
    // patch → run → restore without interleaving.
    const originalText = JSON.stringify({ foo: "bar" }, null, 2);
    await fs.writeFile(tempSettingsPath, originalText, "utf8");

    mockFound();

    // Order of events we expect when run serialised:
    //   read-original(A), write-high(A), <release A to subprocess>,
    //   read-original(B; == originalText, since A restored), write-low(B), ...
    //
    // We assert that inside each run's subprocess phase, the settings file
    // content corresponds to THAT run's thinking level — no bleed.
    const snapshots: Array<{ run: "A" | "B"; content: string }> = [];

    // Controllable gates for the two runs' subprocess calls.
    type Gate = {
      promise: Promise<void>;
      release: () => void;
    };
    function gate(): Gate {
      let release!: () => void;
      const promise = new Promise<void>((r) => {
        release = r;
      });
      return { promise, release };
    }
    const gateA = gate();
    const gateB = gate();

    let callNo = 0;
    runSubprocessMock.mockImplementation(async () => {
      callNo++;
      if (callNo === 1) {
        // This is the FIRST dispatch to reach the subprocess — capture its
        // settings.json, wait for the test to release it, then return.
        const content = await fs.readFile(tempSettingsPath, "utf8");
        snapshots.push({ run: "A", content });
        await gateA.promise;
        return ok({ stdout: JSON.stringify({ response: "A-done" }) });
      } else {
        const content = await fs.readFile(tempSettingsPath, "utf8");
        snapshots.push({ run: "B", content });
        await gateB.promise;
        return ok({ stdout: JSON.stringify({ response: "B-done" }) });
      }
    });

    const dA = new GeminiDispatcher(baseSvc({ thinkingLevel: "high" }));
    const dB = new GeminiDispatcher(baseSvc({ thinkingLevel: "low" }));

    // Kick off both in parallel. Because the lock is module-level, B must
    // wait for A's full patch → subprocess → restore cycle to finish.
    const pA = dA.dispatch("A", [], "");
    const pB = dB.dispatch("B", [], "");

    // Give A enough time to reach runSubprocess.
    // We wait until the first snapshot appears.
    for (let i = 0; i < 100 && snapshots.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // At this point A is suspended inside runSubprocess with HIGH in settings.
    expect(snapshots.length).toBe(1);
    const first = snapshots[0];
    expect(first).toBeDefined();
    expect(first!.run).toBe("A");
    expect(first!.content).toMatch(/"thinkingLevel":\s*"HIGH"/);
    // And B must NOT have snapshotted yet — lock holds it out.
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshots.length).toBe(1);

    // Release A — its restore phase runs, then B acquires the lock.
    gateA.release();

    // Wait for B to reach runSubprocess.
    for (let i = 0; i < 100 && snapshots.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(snapshots.length).toBe(2);
    const second = snapshots[1];
    expect(second).toBeDefined();
    expect(second!.run).toBe("B");
    // B must see a fully-restored original plus its own LOW injection —
    // specifically NOT HIGH bleed from A.
    expect(second!.content).toMatch(/"thinkingLevel":\s*"LOW"/);
    expect(second!.content).not.toMatch(/"thinkingLevel":\s*"HIGH"/);

    gateB.release();
    await pA;
    await pB;

    // After both complete, the lock should be drained and settings.json
    // restored to the original we wrote at the start.
    await _geminiLockIdle();
    const finalText = await fs.readFile(tempSettingsPath, "utf8");
    expect(finalText).toBe(originalText);
  });
});
