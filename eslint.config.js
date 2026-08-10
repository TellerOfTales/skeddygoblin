import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Two of the rules below encode CLAUDE.md conventions as build failures rather
 * than review comments:
 *
 *   1. The layer boundary (discord -> services -> db). A Discord view that
 *      cannot import the db layer cannot leak a raw record, which is half of
 *      the "aggregate only" privacy principle enforced structurally.
 *   2. The notifier boundary. The brief says every outbound user message must
 *      go through notify(); DiscordDMNotifier.ts is the only file allowed to
 *      call the Discord send API. There is also a test for this (P5), so a
 *      skipped lint step cannot hide a violation.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.pgdata/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },

  // process.env has exactly one reader: src/config.ts.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/config.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from src/config.ts, which validates it at boot.',
        },
      ],
    },
  },

  // Layer boundary: the Discord adapter may not reach past the service layer.
  {
    files: ['src/discord/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/**', '../db/*', '../../db/*'],
              message:
                'The Discord layer must go through src/services/. Direct db access would let a view hold a raw per-user record.',
            },
          ],
        },
      ],
    },
  },

  // Layer boundary: services must stay platform-agnostic so the domain core can
  // be reused by a future HTTP API / console client.
  {
    files: ['src/services/**/*.ts', 'src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['discord.js', '**/discord/**'],
              message:
                'Services and domain must not depend on Discord. Outbound messages go through the Notifier interface.',
            },
          ],
        },
      ],
    },
  },

  // Notifier boundary: DiscordDMNotifier.ts is the only permitted send site.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/notify/DiscordDMNotifier.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression > MemberExpression[property.name='createDM']",
          message:
            'Only src/notify/DiscordDMNotifier.ts may open a DM channel. Use notify() instead.',
        },
        {
          selector: "MemberExpression[property.name='users'][object.property.name='client']",
          message:
            'Only src/notify/DiscordDMNotifier.ts may reach client.users. Use notify() instead.',
        },
      ],
    },
  },

  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Plain-JS build scripts (scripts/make-logo.mjs) run on bare Node, outside the
  // TypeScript program, so they need Node's globals declared and stdout allowed.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { Buffer: 'readonly', console: 'readonly', process: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },

  // Boot, migrations and the command registrar legitimately write to stdout.
  {
    files: ['src/index.ts', 'src/logger.ts', 'src/config.ts', 'src/db/migrate.ts'],
    rules: { 'no-console': 'off' },
  },
);
