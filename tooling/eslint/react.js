import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

import { base } from './index.js';

export const react = tseslint.config(...base, {
  files: ['**/*.{ts,tsx}'],
  plugins: { react: reactPlugin, 'react-hooks': reactHooks },
  settings: { react: { version: 'detect' } },
  rules: {
    ...reactHooks.configs.recommended.rules,
    'react/jsx-key': 'error',
    'react/self-closing-comp': 'error',
    // React 19 + JSX runtime: import gerekmez.
    'react/react-in-jsx-scope': 'off',
  },
});

export default react;
