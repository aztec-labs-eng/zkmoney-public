import base from '../eslint.config.js';

export default [
  ...base,
  {
    files: ['src/**/artifact.ts'],
    rules: { 'import-x/no-relative-packages': 'off' },
  },
];
