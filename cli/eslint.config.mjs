import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Flat ESLint config for the ghostchars npm package.
 *
 * This config encodes the two standards a reviewer cannot enforce by eye,
 * plus one rule specific to this package:
 *
 *  1. **Zero `as` casts.** `consistent-type-assertions: { assertionStyle: 'never' }`
 *     makes every `x as T` an ERROR. `as const` is not an assertion in the
 *     rule's eyes, so the sanctioned form still compiles. This package ships
 *     zero runtime dependencies, so zod is not available at runtime: anything
 *     crossing a trust boundary (a `ghostchars.json`, a JSON payload, a thrown
 *     errno object) is narrowed with a hand-written type guard.
 *  2. **No `any`.** `no-explicit-any: error`.
 *
 * THE ONE ADDITION: `no-console: error`, with no allow list. The MCP server
 * speaks JSON-RPC on fd 1, and a single `console.log` anywhere in a shared code
 * path corrupts the stream for the whole session. Nothing in this package has a
 * legitimate reason to reach the console directly: `src/io.ts` owns both
 * streams, and in MCP mode it points the public stdout writer at stderr.
 *
 * There is no eslint-side alias config, and none is needed: `projectService`
 * reads the same `tsconfig.json` whose `paths` map `@ghostchars/engine` onto
 * `../web/src/engine/*.ts`, so the type-aware rules resolve the engine exactly
 * the way `tsc` does.
 */
export default defineConfig([
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    // Plain JS/MJS build and release scripts: no type information, so the
    // type-checked rule set must be switched off or ESLint errors on the
    // missing program.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // A separate block, because spreading `disableTypeChecked` above brings its
    // own `rules` object with it and a second `rules` key in the same object
    // would replace it wholesale rather than adding to it. The build and
    // release scripts are allowed to print: they are operator tools, not the
    // shipped binary, and they never share a process with the MCP server.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    rules: { 'no-console': 'off' },
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/'],
  },
])
