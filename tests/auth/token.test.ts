/**
 * Tests for the auth-token module.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareBearerToken,
  generateToken,
  openAuthTokenStore,
  parseBearerHeader,
  tokenFilePermissions,
} from "../../src/auth/token.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "harness-router-auth-test-"));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
});

describe("generateToken", () => {
  it("produces a 256-bit base64url string", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url = ceil(32 / 3) * 4 - padding = 43 chars (no padding).
    expect(t.length).toBeGreaterThanOrEqual(40);
    expect(t.length).toBeLessThanOrEqual(44);
  });

  it("returns different values across calls (random sanity)", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

describe("compareBearerToken", () => {
  it("returns true for exact match", () => {
    const t = generateToken();
    expect(compareBearerToken(t, t)).toBe(true);
  });

  it("returns false for mismatched tokens", () => {
    expect(compareBearerToken("a", "b")).toBe(false);
  });

  it("returns false for length-mismatch tokens (no constant-time leak)", () => {
    expect(compareBearerToken("short", "much-longer-token")).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(compareBearerToken("", "anything")).toBe(false);
    expect(compareBearerToken("anything", "")).toBe(false);
    expect(compareBearerToken("", "")).toBe(false);
  });
});

describe("parseBearerHeader", () => {
  it("extracts a token from a well-formed Authorization header", () => {
    expect(parseBearerHeader("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(parseBearerHeader("bearer abc123")).toBe("abc123");
    expect(parseBearerHeader("BEARER abc123")).toBe("abc123");
  });

  it("returns null when the header is missing", () => {
    expect(parseBearerHeader(undefined)).toBeNull();
  });

  it("returns null for non-Bearer schemes", () => {
    expect(parseBearerHeader("Basic abc123")).toBeNull();
    expect(parseBearerHeader("Token abc123")).toBeNull();
  });

  it("returns null for malformed headers", () => {
    expect(parseBearerHeader("Bearer")).toBeNull();
    expect(parseBearerHeader("")).toBeNull();
  });

  it("uses the first value when given an array (Node multi-value header)", () => {
    expect(parseBearerHeader(["Bearer abc123", "Bearer xyz"])).toBe("abc123");
  });
});

describe("openAuthTokenStore", () => {
  it("read returns null when no file exists", () => {
    const store = openAuthTokenStore(undefined, join(tmp, "auth.token"));
    expect(store.read()).toBeNull();
    expect(store.exists()).toBe(false);
  });

  it("create writes a new token and read returns it", () => {
    const path = join(tmp, "auth.token");
    const store = openAuthTokenStore(undefined, path);
    const t = store.create();
    expect(store.read()).toBe(t);
    expect(store.exists()).toBe(true);
    // Token persisted to disk verbatim.
    expect(readFileSync(path, "utf-8")).toBe(t);
  });

  it("rotate replaces an existing token with a new value", () => {
    const path = join(tmp, "auth.token");
    const store = openAuthTokenStore(undefined, path);
    const a = store.create();
    const b = store.rotate();
    expect(b).not.toBe(a);
    expect(store.read()).toBe(b);
  });

  it("revoke deletes the token file", () => {
    const path = join(tmp, "auth.token");
    const store = openAuthTokenStore(undefined, path);
    store.create();
    expect(store.exists()).toBe(true);
    store.revoke();
    expect(store.exists()).toBe(false);
    expect(store.read()).toBeNull();
  });

  it("revoke is idempotent (no error when file already gone)", () => {
    const store = openAuthTokenStore(undefined, join(tmp, "auth.token"));
    expect(() => store.revoke()).not.toThrow();
  });

  it("trims whitespace from the persisted value (tolerant to manual edits)", () => {
    const path = join(tmp, "auth.token");
    writeFileSync(path, "  test-token-with-whitespace\n", "utf-8");
    const store = openAuthTokenStore(undefined, path);
    expect(store.read()).toBe("test-token-with-whitespace");
  });
});

describe("tokenFilePermissions", () => {
  it("returns null when the file doesn't exist", () => {
    expect(tokenFilePermissions(join(tmp, "missing.token"))).toBeNull();
  });

  it("returns 0o600 after store.create() (POSIX)", () => {
    if (process.platform === "win32") return; // Windows mode bits don't track 0o600.
    const path = join(tmp, "auth.token");
    const store = openAuthTokenStore(undefined, path);
    store.create();
    const perms = tokenFilePermissions(path);
    expect(perms).toBe("0o600");
  });

  it("returns the actual mode for an externally-created file", () => {
    if (process.platform === "win32") return;
    const path = join(tmp, "loose.token");
    writeFileSync(path, "x", { mode: 0o644 });
    const perms = tokenFilePermissions(path);
    expect(perms).toBe("0o644");
    // sanity
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});
