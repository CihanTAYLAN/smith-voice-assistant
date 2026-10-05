import { base } from '@smith/eslint-config';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/node_modules/**',
      'tooling/eslint/*.js',
    ],
  },
  ...base,
  {
    // scripts/ ve seed CLI araclaridir; console ciktisi bunlarin arayuzudur.
    files: ['scripts/**/*.ts', '**/prisma/seed.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
