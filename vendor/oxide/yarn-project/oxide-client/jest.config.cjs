// Minimal jest config for a pure-library package. Uses @swc/jest for fast TS transform; the
// foundation setup files initialise globals (e.g. BarretenbergSync) the crypto helpers need.
module.exports = {
  extensionsToTreatAsEsm: ['.ts'],
  testRegex: '.*\\.test\\.(js|mjs|ts)$',
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
    '^@oxide/oxide-lib/(.*)\\.js$': '<rootDir>/../../oxide-lib/src/$1.ts',
    '^(\\.{1,2}/.*)\\.[cm]?js$': '$1',
  },
  moduleDirectories: ['node_modules', '<rootDir>/../../node_modules'],
  setupFiles: ['<rootDir>/../../node_modules/@aztec/foundation/src/jest/setup.mjs'],
  setupFilesAfterEnv: ['<rootDir>/../../node_modules/@aztec/foundation/src/jest/setupAfterEnv.mjs'],
  testEnvironment: '<rootDir>/../../node_modules/@aztec/foundation/src/jest/env.mjs',
};
