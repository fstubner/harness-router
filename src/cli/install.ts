/**
 * `harness-router install` / `uninstall` — wire the router into MCP
 * host configs (Claude Desktop / Claude Code / Cursor / Codex).
 *
 * The pattern: prefer the host's own CLI command if it has one (Claude
 * Code's `claude mcp add`), fall back to direct file edit otherwise
 * (Claude Desktop, Cursor, Codex). Idempotent — running twice is a
 * no-op the second time.
 *
 * `--print` prints the per-host config snippet without writing anything,
 * for users who want to copy-paste manually.
 *
 * `--target <id>` restricts to one host by id (`claude-desktop` |
 * `claude-code` | `cursor` | `codex`).
 *
 * `--name <name>` overrides the entry name (default: `harness-router`).
 * Useful when running multiple routers side-by-side.
 */

import {
  INSTALL_TARGETS,
  defaultEntry,
  type InstallTarget,
  type McpServerEntry,
} from "../install/targets.js";

export interface InstallCmdOpts {
  /** Restrict to one host id (`claude-desktop` | `claude-code` | `cursor` | `codex`). */
  target?: string;
  /** Print the snippet instead of writing. Implies dry-run. */
  print?: boolean;
  /** Remove our entry from each host instead of installing. */
  uninstall?: boolean;
  /** Override the entry name (default: `harness-router`). */
  name?: string;
}

function selectTargets(targetId: string | undefined): InstallTarget[] {
  if (!targetId) return INSTALL_TARGETS.slice();
  const found = INSTALL_TARGETS.find((t) => t.id === targetId);
  if (!found) {
    process.stderr.write(
      `install --target: unknown host "${targetId}". Expected one of: ` +
        `${INSTALL_TARGETS.map((t) => t.id).join(", ")}\n`,
    );
    return [];
  }
  return [found];
}

export async function cmdInstall(opts: InstallCmdOpts): Promise<number> {
  const targets = selectTargets(opts.target);
  if (targets.length === 0) return 1;

  const entry: McpServerEntry = {
    ...defaultEntry(),
    ...(opts.name ? { name: opts.name } : {}),
  };

  if (opts.print) {
    for (const t of targets) {
      process.stdout.write(`# ${t.displayName}\n${t.printSnippet(entry)}\n\n`);
    }
    return 0;
  }

  // Detect which hosts are present on this system. Skip + log when a host
  // isn't installed rather than failing the whole batch.
  const present = targets.filter((t) => t.configPath() !== null);
  const missing = targets.filter((t) => t.configPath() === null);

  if (present.length === 0) {
    process.stderr.write(
      "No supported MCP hosts detected on this machine. Looked for:\n" +
        targets.map((t) => `  - ${t.displayName} (${t.id})`).join("\n") +
        "\nIf one of these is installed in a non-default location, configure it manually using\n" +
        "`harness-router install --target <id> --print` and paste the snippet into the host's config.\n",
    );
    return 1;
  }

  for (const t of missing) {
    process.stdout.write(`  ─ ${t.displayName} not detected, skipping\n`);
  }

  let allOk = true;
  const verb = opts.uninstall ? "Uninstalling" : "Installing";
  process.stdout.write(
    `${verb} ${entry.name} into ${present.length} host${present.length === 1 ? "" : "s"}…\n`,
  );
  for (const t of present) {
    const action = opts.uninstall ? t.uninstall(entry.name) : t.install(entry);
    const result = await action;
    if (!result.ok) {
      allOk = false;
      process.stdout.write(`  ✗ ${t.displayName} → ${result.error ?? "unknown error"}\n`);
      continue;
    }
    const where = result.path ? ` (${result.path})` : "";
    if (opts.uninstall) {
      const tag = result.replaced ? "removed" : "not present";
      process.stdout.write(`  ✓ ${t.displayName}: ${tag}${where}\n`);
    } else if (result.alreadyPresent) {
      process.stdout.write(`  ─ ${t.displayName}: already up to date${where}\n`);
    } else if (result.replaced) {
      process.stdout.write(`  ✓ ${t.displayName}: updated entry${where}\n`);
    } else {
      process.stdout.write(`  ✓ ${t.displayName}: added entry${where}\n`);
    }
  }

  if (allOk && !opts.uninstall) {
    process.stdout.write(
      "\nDone. Restart the host(s) to pick up the new MCP server.\n" +
        "Verify the underlying CLIs with `harness-router doctor`.\n",
    );
  }
  return allOk ? 0 : 1;
}
