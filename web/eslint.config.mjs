import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

/**
 * The standards a reviewer cannot enforce by eye: no `any`, no type
 * assertions, no unused bindings, type-only imports where a type is all that
 * is used, and no promise handed to a callback that ignores it.
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
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  { ignores: ['node_modules/'] },
])
