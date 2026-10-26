// Minimal jest config, patterned on yarn-project/oxide-lib-tee/jest.config.cjs.
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
    // ci-jest never builds sibling workspaces' dest/, so resolve @oxide/oxide-lib-tee and @oxide/oxide-lib subpath imports to their TS sources
    '^@oxide/oxide-lib-tee/(.*)\\.js$': '<rootDir>/../../oxide-lib-tee/src/$1.ts',
    '^@oxide/oxide-lib/(.*)\\.js$': '<rootDir>/../../oxide-lib/src/$1.ts',
    '^(\\.{1,2}/.*)\\.[cm]?js$': '$1',
  },
  moduleDirectories: ['node_modules', '<rootDir>/../../node_modules'],
  setupFilesAfterEnv: ['<rootDir>/../../node_modules/@aztec-labs/foundation/src/jest/setupAfterEnv.mjs'],
  testEnvironment: '<rootDir>/../../node_modules/@aztec-labs/foundation/src/jest/env.mjs',
};
