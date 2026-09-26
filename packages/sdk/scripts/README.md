## Scripts

Just a collection of useful scripts for testing, debugging, and development.

Scripts are unit tests unless their name says otherwise: `pnpm test -- scripts/<name>.test.ts` runs one with no sandbox. Scripts that need the sandbox are named `.sandbox.test.ts`, and scripts that read a live network `.live.test.ts`; both run with `pnpm test:sandbox scripts/<name>` once their environment is up, and the live ones never run in CI.

They are Vitest files rather than plain `.ts` because Vitest supplies the Aztec-compatible module transform.
