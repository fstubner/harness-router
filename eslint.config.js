// @ts-check
//
// ESLint flat config (ESLint 9+).
//
// Why these rules: every entry below was chosen because it catches a class
// of bug we've actually hit in this codebase or in adjacent TS projects of
// similar shape. We deliberately do NOT enable the entire
// `recommended-type-checked` rule set wholesale — that would flag dozens of
// places where the existing patterns are fine, and the noise would
// undermine the signal. Start narrow; expand once the floor is clean.
//
// Rule choices (rationale follows each):
//
//   no-floating-promises  — async iter cleanup bugs in this codebase have
//                           historically come from un-awaited promises in
//                           generators. Hard error.
//
//   no-misused-promises   — passing an async function where a sync callback
//                           is expected (e.g. event listeners) silently
//                           swallows rejections. Hard error.
//
//   consistent-type-imports — keeps `import type` separate from value
//                             imports so the bundler can drop them. Caught
//                             at least one accidental runtime import in
//                             tools.ts during refactors.
//
//   no-explicit-any       — we have zero `any` in src/. Lock that in.
//
//   prefer-readonly       — class fields that are never reassigned should
//                           be readonly. Catches accidental mutation paths.
//                           Warn-level (cosmetic).
//
//   @vitest/expect-expect — a test that doesn't call `expect` is toothless.
//   @vitest/no-disabled-tests, no-focused-tests — `.skip` / `.only` left
//                           in a commit is a real ship-breaker.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";
import globals from "globals";

export default tseslint.config(
  // Ignore generated and vendored output. Flat config has no implicit
  // .eslintignore — these patterns must be listed explicitly.
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "*.tgz",
      ".vitest-cache/**",
    ],
  },

  // Base recommended set — JS rules from ESLint core + TS rules from
  // typescript-eslint. The type-checked variant pulls in rules that
  // require typing info (no-floating-promises, no-misused-promises,
  // unsafe-* family). We layer our own picks on top.
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // Project-wide config: turn on the type-checked services and pin a
  // sensible base.
  {
    languageOptions: {
      parserOptions: {
        // Both tsconfigs are required so type-aware rules see both `src/`
        // (tsconfig.json) and `tests/` + config files (tsconfig.test.json).
        // Using the explicit `project` array rather than `projectService`
        // because `projectService` only sees files referenced from the
        // root tsconfig — `vitest.config.ts` and tests live in a sibling.
        project: ["./tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        // `void` returns from event listeners / callbacks are fine when
        // the listener is intentionally fire-and-forget. The default
        // checksVoidReturn is too aggressive for our async-iter generator
        // patterns.
        { checksVoidReturn: { attributes: false, arguments: false } },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        // Allow `import("...")` type annotations inline — useful for
        // breaking circular type-import cycles without restructuring.
        // Hand-tuned where it appears, not a general lint risk.
        { disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/prefer-readonly": "warn",
      // Real bug-class: rejecting with a non-Error makes it impossible
      // for downstream `instanceof Error` checks to succeed. Always
      // wrap in `new Error()`.
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      // Off: the Dispatcher interface specifies `checkQuota: () =>
      // Promise<QuotaInfo>`. Implementations that have nothing async to
      // do still must declare `async` to satisfy the contract.
      // `require-await` would force them to either drop `async` (breaking
      // the interface) or insert pointless `await Promise.resolve()`.
      // We accept the rule's loss in coverage for this class of method.
      "@typescript-eslint/require-await": "off",
      // Off: defensive resets like `lineBuffer = ""` after a flush, or
      // `existing = {}` in a try/catch fallback, look "useless" to the
      // analyser but communicate intent for the next reader. The rule
      // fires too often on legitimate patterns.
      "no-useless-assignment": "off",
      // Off: extracting methods via destructure is fine in render-style
      // call sites (`const paint = colors.paint;` then `paint("BOLD", x)`).
      // The unbound-method warning is correct in pure OOP codebases but
      // we use objects-as-namespaces in several places.
      "@typescript-eslint/unbound-method": "off",

      // The recommended-type-checked set includes rules we don't want as
      // hard errors during the v0.1 baseline — too noisy on internal
      // patterns we're keeping. Downgrade to warnings so they're visible
      // without blocking CI; tighten later.
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/no-base-to-string": "warn",

      // We use `unknown` extensively in JSON-path readers and config
      // parsers — those need explicit narrowing, but the noUnusedVars
      // wide-net catches false positives. Allow a leading-underscore
      // escape hatch (matches our `_geminiLockIdle`-style internals).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Disable the recommended `no-unused-vars` so we don't get duplicate
      // reports — typescript-eslint's variant is what's active above.
      "no-unused-vars": "off",
    },
  },

  // Test files — apply vitest plugin's recommended rules + a couple of
  // extras. Tests run with looser type-aware rules because the patterns
  // they use legitimately differ from production code:
  //   - `async` stubs that satisfy an interface but never await
  //   - `as Foo` casts on partial mocks
  //   - `if (condition) expect(...)` inside drained-iterator loops where
  //     the condition narrows a discriminated union
  //   - `function*` generators that throw before yielding (NotImplemented
  //     stubs)
  // None of these are bugs in test code; flagging them as errors costs
  // signal-to-noise without catching real defects.
  {
    files: ["tests/**/*.ts"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/expect-expect": "error",
      "vitest/no-disabled-tests": "error",
      "vitest/no-focused-tests": "error",

      // `if (event.type === "stdout") expect(...)` is the canonical pattern
      // for asserting on a streamed discriminated union — false positive.
      "vitest/no-conditional-expect": "off",
      // `it.each` with a function-shaped title would trip this; we don't
      // use that pattern but the rule sometimes fires on dynamic titles
      // built via template strings. Off to keep signal high.
      "vitest/valid-title": "off",

      // Test stubs implement `async`/`async *` methods to satisfy the
      // Dispatcher interface even when they don't await anything — those
      // are interface-satisfaction, not "forgot to await".
      "@typescript-eslint/require-await": "off",
      "require-yield": "off",
      // Stub builders use `as Type` extensively to avoid recreating every
      // optional field. Auto-fixed across src/; in tests, the casts are
      // intentional partial-mock shorthand.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Mocks return whatever shape vitest's `vi.fn` produces; the unsafe-*
      // family fires constantly on `runSubprocessMock.mock.calls[0]` and
      // similar. Already disabled for src as `warn`; turn fully off here.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  // Scripts directory — small JS/TS tools, looser rules.
  {
    files: ["scripts/**/*.{js,mjs,ts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // Plain JS / MJS / CJS files (eslint.config.js itself, scripts/*.mjs,
  // anything else outside the tsconfig include sets). These aren't
  // covered by either tsconfig, so the type-aware rules can't resolve
  // types for them. Disable typed linting for this block; basic syntax
  // / hygiene rules still apply via `js.configs.recommended`.
  // The `**/` prefix is required — flat-config globs are not implicitly
  // recursive, so `*.mjs` would only match at the repo root.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      parserOptions: {
        // Tell typescript-eslint not to attempt type-aware parsing here.
        project: false,
      },
    },
    // Disable the type-checked rules — they'd error on every line.
    ...tseslint.configs.disableTypeChecked,
  },
);
