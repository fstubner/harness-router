/**
 * `harness-router auth { create | show | rotate | revoke }` — token mgmt.
 *
 * Each subcommand is a thin wrapper around src/auth/token.ts. The CLI
 * surface is deliberately minimal: tokens are an HTTP-only concept and
 * most users will never run these commands.
 */

import { openAuthTokenStore, tokenFilePermissions } from "../auth/token.js";

export interface AuthCmdOpts {
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

export async function cmdAuth(action: string, opts: AuthCmdOpts = {}): Promise<number> {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const store = openAuthTokenStore();

  switch (action) {
    case "create": {
      if (store.exists()) {
        err.write(
          `auth create: a token already exists at ${store.path}. ` +
            `Use \`auth rotate\` to replace it or \`auth revoke\` to delete it.\n`,
        );
        return 1;
      }
      const t = store.create();
      out.write(`Created auth token at ${store.path}\n\n`);
      out.write(`  ${t}\n\n`);
      out.write("Send this in `Authorization: Bearer <token>` for non-loopback HTTP requests.\n");
      return 0;
    }
    case "show": {
      const t = store.read();
      if (!t) {
        err.write(`auth show: no token at ${store.path}. Run \`auth create\` first.\n`);
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
    case "rotate": {
      const t = store.rotate();
      out.write(`Rotated token at ${store.path}\n\n  ${t}\n\n`);
      out.write(
        "Update any client that was using the old token; old token is no longer accepted.\n",
      );
      return 0;
    }
    case "revoke": {
      if (!store.exists()) {
        out.write(`auth revoke: no token at ${store.path} (already gone).\n`);
        return 0;
      }
      store.revoke();
      out.write(`Revoked token at ${store.path}.\n`);
      return 0;
    }
    default:
      err.write(`auth: unknown action "${action}". Expected: create, show, rotate, revoke.\n`);
      return 1;
  }
}
