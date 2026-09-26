// Minimal jest config. Patterned on yarn-project/end-to-end/jest.config.cjs but trimmed
// for a pure-library package (no noir/acvm stack). Uses @swc/jest for fast TS transform.
module.exports = {
  extensionsToTreatAsEsm: ['.ts'],
  testRegex: './src/.*\\.test\\.(js|mjs|ts)$',
  rootDir: './src',
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript' } },
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.[cm]?js$': '$1',
  },
  moduleDirectories: ['node_modules', '<rootDir>/../../node_modules'],
  setupFilesAfterEnv: ['<rootDir>/../../node_modules/@aztec/foundation/src/jest/setupAfterEnv.mjs'],
  testEnvironment: '<rootDir>/../../node_modules/@aztec/foundation/src/jest/env.mjs',
};
