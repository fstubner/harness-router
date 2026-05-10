/**
 * `harness-router auth [rotate]` — token retrieval and rotation.
 *
 * Tokens are an HTTP-only concept. Most users never run these commands —
 * the HTTP server auto-creates a token on first non-loopback bind, prints
 * the path to stderr, and you read the file. This subcommand exists for
 * the two cases where the file approach is awkward:
 *
 *   `harness-router auth`         — print the token (so you can hand it to
 *                                    a remote client without `cat`-ing the
 *                                    file across systems) + warn if the
 *                                    permissions are looser than 0o600.
 *   `harness-router auth rotate`  — replace the token. Equivalent to
 *                                    `rm <path> && restart server`, but
 *                                    survives across processes that have
 *                                    the file open and removes the
 *                                    "now find the path again" friction.
 *
 * No `create`: the HTTP server auto-creates. No `revoke`: `rm <path>`
 * is one fewer command to remember and identical in effect.
 */

import { openAuthTokenStore, tokenFilePermissions } from "../auth/token.js";

export interface AuthCmdOpts {
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

export async function cmdAuth(action: string | undefined, opts: AuthCmdOpts = {}): Promise<number> {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const store = openAuthTokenStore();

  if (action === undefined || action === "show") {
    const t = store.read();
    if (!t) {
      err.write(
        `auth: no token at ${store.path}. ` +
          `Start the HTTP server with a non-loopback bind to auto-create one, ` +
          `or run \`harness-router auth rotate\`.\n`,
      );
      return 1;
    }
    const perms = tokenFilePermissions(store.path);
    out.write(`Token at ${store.path}:\n\n  ${t}\n\n`);
    if (perms && perms !== "0o600") {
      err.write(
        `Warning: token file permissions are ${perms} (expected 0o600). ` +
          `Run \`chmod 600 ${store.path}\` to tighten.\n`,
      );
    }
    return 0;
  }

  if (action === "rotate") {
    const t = store.rotate();
    out.write(`Rotated token at ${store.path}\n\n  ${t}\n\n`);
    out.write(
      "Update any client that was using the old token; the old token is no longer accepted.\n",
    );
    return 0;
  }

  err.write(`auth: unknown action "${action}". Expected: (no arg) or rotate.\n`);
  return 1;
}
