import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'var/**',
      'data/**',
      'fixtures/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The project service resolves each file to its nearest tsconfig, so package
        // source, tests and the web app are all type-aware. Files outside any tsconfig
        // are listed explicitly below.
        projectService: {
          allowDefaultProject: ['*.ts', '*.mjs', 'scripts/*.mjs', 'e2e/*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Tests intentionally reach into partially-formed values, assert on `any` shapes
    // read back from untyped JSON responses, and mix `await` with intentionally
    // unawaited cleanup.
    files: ['**/*.test.ts', '**/*.test.tsx', 'e2e/**/*.ts', 'fixtures/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Narrowing an untyped JSON response with `as Shape` reads better than threading
      // a type argument through every `response.json()` call.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    // Plain build scripts: no type information is available for them.
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/*.config.ts', '**/*.config.mts', 'eslint.config.mjs'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['packages/server/**/*.ts', 'packages/core/**/*.ts', 'packages/ingest/**/*.ts', 'packages/parsers/**/*.ts', 'packages/artifacts/**/*.ts', 'scripts/**/*.mjs', '*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
