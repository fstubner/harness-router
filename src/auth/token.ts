/**
 * Bearer-token storage for the HTTP transport's optional auth gate.
 *
 * A single token lives at `~/.harness-router/auth.token` chmod 600 (POSIX)
 * or restricted to the current user (Windows). Generated on demand by the
 * `auth` subcommand or the HTTP server when `bind != loopback`. Constant-
 * time compared against the `Authorization: Bearer …` header on every
 * non-loopback request.
 *
 * Threat model:
 *   - Loopback connections bypass auth (the OS process boundary is the
 *     real boundary there).
 *   - Non-loopback connections REQUIRE auth. The HTTP loader force-enables
 *     this regardless of config (see src/v3/loader.ts parseHttp).
 *   - Token is 32 random bytes base64url-encoded (~43 chars, 256 bits).
 *   - We never log the token. Errors are generic 401s, not "wrong token".
 *
 * The token file is plaintext — same trust level as ~/.ssh/id_*. If the
 * user's home directory is compromised the attacker has the token; that's
 * outside our threat model (and same as every other CLI tool's secrets).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

export function defaultTokenPath(): string {
  return (
    process.env.HARNESS_ROUTER_AUTH_TOKEN_FILE ?? join(homedir(), ".harness-router", "auth.token")
  );
}

export interface TokenIO {
  read(path: string): string | null;
  write(path: string, value: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
}

const defaultIO: TokenIO = {
  read(p) {
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf-8").trim();
  },
  write(p, value) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, value, { mode: 0o600 });
    // Belt-and-braces: chmod again in case the umask widened the file at create.
    try {
      chmodSync(p, 0o600);
    } catch {
      // Windows: chmod is a no-op for permission bits but doesn't throw.
    }
  },
  remove(p) {
    if (existsSync(p)) unlinkSync(p);
  },
  exists(p) {
    return existsSync(p);
  },
};

/** Generate a fresh 256-bit token, base64url-encoded. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time bearer-token check. Both inputs base64url; lengths must
 * match. Empty inputs are rejected. Returns true iff equal.
 */
export function compareBearerToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AuthTokenStore {
  /** Path to the token file (or override from env). */
  path: string;
  /** Read the current token, or null if no file exists. */
  read(): string | null;
  /** Generate + persist a new token; returns the value written. */
  create(): string;
  /** Replace the token with a fresh one; returns the new value. */
  rotate(): string;
  /** Delete the token file. */
  revoke(): void;
  /** True if the token file exists. */
  exists(): boolean;
}

export function openAuthTokenStore(io: TokenIO = defaultIO, path?: string): AuthTokenStore {
  const p = path ?? defaultTokenPath();
  return {
    path: p,
    read() {
      const t = io.read(p);
      return t && t.length > 0 ? t : null;
    },
    create() {
      const t = generateToken();
      io.write(p, t);
      return t;
    },
    rotate() {
      const t = generateToken();
      io.write(p, t);
      return t;
    },
    revoke() {
      io.remove(p);
    },
    exists() {
      return io.exists(p);
    },
  };
}

/**
 * Inspect the file's permission bits. Returns null when the file doesn't
 * exist, an octal string ('0o600' / '0o644' / etc.) when it does. Used by
 * `auth show` to flag overpermissive token files.
 */
export function tokenFilePermissions(path: string = defaultTokenPath()): string | null {
  try {
    const s = statSync(path);
    return `0o${(s.mode & 0o777).toString(8).padStart(3, "0")}`;
  } catch {
    return null;
  }
}

/**
 * Parse an Authorization header value, returning the bearer token or null.
 * Tolerant of leading/trailing whitespace; case-insensitive on the scheme.
 */
export function parseBearerHeader(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(value);
  return m ? (m[1] ?? null) : null;
}
