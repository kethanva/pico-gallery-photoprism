import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/**
 * Flat config for the monorepo. TypeScript only — JS/config files are ignored
 * except plain Node scripts (`scripts/*.mjs`), which get a Node global set.
 * `no-undef` is turned off for TS via the plugin's eslint-recommended overrides
 * (tsc already resolves identifiers, and the rule has no DOM/Node global
 * awareness in this setup).
 */
const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  globalThis: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
};

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'sample_photos/**',
      'agent/**',
      'frame/**',
      'plan/**',
      'plans/**',
      '**/*.config.ts',
      '**/*.config.mjs',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs['eslint-recommended'].overrides[0].rules,
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
  },
];
