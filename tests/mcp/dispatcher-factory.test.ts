/**
 * Dispatcher-factory unit tests.
 *
 * Focus: the auto-promote behaviour — a `type: cli` service whose harness
 * isn't in the built-in HARNESS_TABLE but whose `command` IS set should fall
 * through to `GenericCliDispatcher` instead of being silently skipped.
 *
 * Why this matters: it's the friction-reduction the user asked for. Adding
 * any new CLI to the router becomes a one-line YAML entry:
 *
 *   my_new_tool:
 *     command: my-new-tool
 *
 * Without auto-promote, the same config required `type: generic_cli` and a
 * separate dispatcher path. With auto-promote the YAML registers the tool
 * unambiguously and the router treats it as a generic CLI under the hood.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceConfig } from "../../src/types.js";

// We mock `which` so the test doesn't depend on PATH state.
vi.mock("which", () => ({ default: vi.fn() }));

const { default: which } = await import("which");
const whichMock = which as unknown as ReturnType<typeof vi.fn>;
const { makeDispatcher } = await import("../../src/mcp/dispatcher-factory.js");
const { GenericCliDispatcher } = await import("../../src/dispatchers/generic-cli.js");
const { ClaudeCodeDispatcher } = await import("../../src/dispatchers/claude-code.js");
const { CopilotDispatcher } = await import("../../src/dispatchers/copilot.js");

function svc(o: Partial<ServiceConfig> & { name: string }): ServiceConfig {
  return {
    enabled: true,
    type: "cli",
    tier: 1,
    weight: 1,
    cliCapability: 1,
    capabilities: {},
    escalateOn: [],
    ...o,
  } as ServiceConfig;
}

beforeEach(() => {
  whichMock.mockReset();
  whichMock.mockResolvedValue("/usr/local/bin/test-bin");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeDispatcher — built-in harnesses", () => {
  it("constructs a ClaudeCodeDispatcher for harness=claude_code", async () => {
    const d = await makeDispatcher("my_claude", svc({ name: "my_claude", harness: "claude_code" }));
    expect(d).toBeInstanceOf(ClaudeCodeDispatcher);
  });

  it("constructs a CopilotDispatcher for harness=copilot (added in 0.1.0)", async () => {
    const d = await makeDispatcher("my_copilot", svc({ name: "my_copilot", harness: "copilot" }));
    expect(d).toBeInstanceOf(CopilotDispatcher);
  });
});

describe("makeDispatcher — auto-promote unknown `type: cli` to GenericCliDispatcher", () => {
  it("auto-promotes a service whose harness is unknown but `command` is set", async () => {
    // The minimum-viable YAML: just `command: my-new-tool`. Everything else
    // (harness, recipe) defaults via the existing config parser. The factory
    // should reach this code path and return a GenericCliDispatcher.
    const d = await makeDispatcher(
      "my_new_tool",
      svc({ name: "my_new_tool", command: "my-new-tool" }),
    );
    expect(d).toBeInstanceOf(GenericCliDispatcher);
    // The dispatcher should report itself as available since `which` returned
    // a path (mocked).
    expect(d?.isAvailable()).toBe(true);
  });

  it("returns undefined when both the harness and `command` are absent (nothing to dispatch)", async () => {
    const d = await makeDispatcher(
      "broken",
      svc({ name: "broken", harness: "totally_unknown_harness" }),
    );
    // Nothing usable here — no built-in mapping, no command. Skip cleanly.
    expect(d).toBeUndefined();
  });

  it("gives precedence to a built-in harness over auto-promote when harness DOES match", async () => {
    // Even if `command` is set, a known harness should still get its
    // hand-tuned dispatcher. Auto-promote is a fallback, not an override.
    const d = await makeDispatcher(
      "claude_with_cmd",
      svc({ name: "claude_with_cmd", harness: "claude_code", command: "claude" }),
    );
    expect(d).toBeInstanceOf(ClaudeCodeDispatcher);
    expect(d).not.toBeInstanceOf(GenericCliDispatcher);
  });

  it("auto-promote dispatcher reports unavailable when the binary isn't on PATH", async () => {
    whichMock.mockResolvedValue(null);
    const d = await makeDispatcher(
      "missing_tool",
      svc({ name: "missing_tool", command: "missing-tool" }),
    );
    expect(d).toBeInstanceOf(GenericCliDispatcher);
    expect(d?.isAvailable()).toBe(false);
  });
});
