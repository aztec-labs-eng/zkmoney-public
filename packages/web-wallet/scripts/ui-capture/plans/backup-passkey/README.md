# Backup passkey plans

One plan per screen id that `selectBackupScreen` (`src/features/backupPasskey/backupScreen.ts`) picks, each at 402×879 and 1280×832. A plan opens Settings › Passkeys once per state of its screen and names each screenshot after its Figma frame (Web Wallet › Settings › Passkeys): A1–A7 the add, B1–B4 why it can't start, C1–C8 its errors, and L3 the pay step from the page's Live UI section.

```sh
for plan in scripts/ui-capture/plans/backup-passkey/*.json; do
  pnpm ui:capture --plan "$plan" --output-dir "$OUT/$(basename "$plan" .json)"
done
```

`?backupFixture=<name>` picks a state from `fixtures/backup-passkey.ts`: the keys the sheet's read returns and the selector input laid over the host's. The real selector picks the screen and its props, and the screen's own component draws it, so a screen rebuilt in its `screens/<Name>` file shows up here with no change to its plan. The page marks the picked id on `html[data-backup-screen]`, which each plan waits for. The plans also set `flowFixture=success` for the capture's wallet and contract service. The capture server strips every `VITE_*`, so a backup fixture turns `VITE_BACKUP_PASSKEY_SETTINGS` on itself, and every fixture reads the same wall time (`CAPTURE_NOW`), so the tracker's times don't drift between runs.

These captures show what each screen draws for a state; loading and recovery still draw today's panel inside the sheet. They do not run a passkey ceremony, sign, fund or watch the chain, and the plans tap nothing that would. The add runs end to end only on the local sandbox. `test/dev/captureBackupPasskey.test.ts` checks that every state picks its plan's screen and that every screen id has a plan; add a state to `BACKUP_FIXTURES` and to its screen's plan together.
