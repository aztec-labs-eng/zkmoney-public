# Savings plans

`funded.json` opens `/savings` on an account with one funded Sky holding, then the account menu and a move in up to its review. `vaults.json` opens `/savings` on an account that also holds a listed USDC vault, then the account menu. `delayed.json` opens `/activity` on that account with a move the relayer dropped, then its sheet and a vault move's. `list.json` opens the Savings activity list on the `delayed` account, then a claimed move in to the vault. `earning.json` opens `/savings` under each fixture that draws "You're earning on" in another state. `details.json` opens a vault's details from its row: Sky funded, a new vault with nothing held (`fresh`), and a vault no longer listed. `move.json` opens the move sheet: a move in on Sky, "Change" and the USDC vault picked, up to its review; a move in with one vault listed (`funded`); and a move out of a vault no longer listed (`exit`), past what it holds; and a move in under a profile with no words (`unworded`). `switch.json` opens the move sheet on two vaults that switch (`switch`): To Main Account, the "Move to" picker, a higher-rate and a lower-rate vault, and the review; a switch under a profile with no words (`switchUnworded`), which goes to Main Account and is blocked into a vault; then the one-vault page and sheet (`funded`). `switched.json` opens the Savings activity on a switch pending, done, recovered and delayed (`switched`), each one's details, the same rows in Activity, and the Savings page with the switch pending. `sky-switch.json` opens the move sheet on Sky and the USDC vault on an executor with the Sky converter adapter (`skySwitch`): from Sky, the "Move to" picker, the vault picked and the review; then the same from the vault into Sky. Run each at a phone and a desktop size:

```sh
pnpm ui:capture --plan scripts/ui-capture/plans/savings/funded.json --viewport 402x879,1280x832
pnpm ui:capture --plan scripts/ui-capture/plans/savings/vaults.json --viewport 402x879,1280x832
pnpm ui:capture --plan scripts/ui-capture/plans/savings/delayed.json --viewport 402x879,1280x832
pnpm ui:capture --plan scripts/ui-capture/plans/savings/list.json --viewport 402x879,1280x832
pnpm ui:capture --plan scripts/ui-capture/plans/savings/earning.json --viewport 402x879,1280x832
pnpm ui:capture --plan scripts/ui-capture/plans/savings/details.json --viewport 402x879,1280x832
pnpm ui:capture --plan scripts/ui-capture/plans/savings/move.json --viewport 402x879,1280x832
pnpm ui:capture --plan scripts/ui-capture/plans/savings/switch.json --viewport 402x879,1280x832
pnpm ui:capture --plan scripts/ui-capture/plans/savings/switched.json --viewport 402x879,1280x832
pnpm ui:capture --plan scripts/ui-capture/plans/savings/sky-switch.json --viewport 402x879,1280x832
```

`?savingsFixture=<name>` (`fixtures/savings-seed.ts`) needs an active `flowFixture`, and each path a plan loads carries it. `funded` gives the demo what Savings reads:

- **Holdings.** The primed deployment gains a Sky savings bridge and one Sky feature that binds it, so the real `pinnedHoldings` and `holdingCatalog` list the holding.
- **Prices.** The demo's L1 answers the vault's `asset()` and `convertToAssets()`, now and a rate window ago, so the real price read gives a share price of 1.10 and a rate of 3.8%.
- **Shares.** 500 shares under the demo account in the balance store, worth $550.00, and the `firstBalance` milestone, which no sync reaches here.
- **Moves.** Through the moves store's transition: a claimed move in that cost $540.00, so the shares have earned $10.00, and a move in still on its way. Each move's quote is at its own line's price, in its asset's decimals.

`vaults` adds a second line on the executor rail:

- **Holdings.** The deployment gains a vault bridge, a `multistep` feature and a vault feature that binds them, and the fixture's profile lists Sky then the vault.
- **Prices.** The vault answers `symbol()` as vUSDC, and its asset answers `symbol()` as USDC and `decimals()` as 6, so the real price read gives a share price of 1.05 USDC and a rate of 6.5%.
- **Shares and moves.** 300 vault shares, worth $315.00, bought by a claimed move in that cost $300.00. With Sky's, Savings is worth $865.00 and has earned $25.00, at a value-weighted 4.8%.

`delayed` holds the same two lines, with a move in to Sky a day past the relayer's max pending age in place of the one on its way. Its burn's withdrawal record waits on its release, which the real `selectMoveState` reads.

Every fixture's profile but `unworded`'s and `switchUnworded`'s names its lines in `holdingCopy`: each one's rate name and facts, and the vault's with `new`. Six more fixtures draw the list's other states, each over Sky and the USDC vault:

- `fresh` lists both while only Sky's shares are held.
- `exit` lists Sky alone while the vault's shares stay held, so the vault moves out only.
- `delisted` lists none while Sky's shares stay held.
- `loading` writes no shares, so the lines stay unread.
- `unrated` answers no data for the vault's price a rate window ago, so it has no rate.
- `unpriced` answers no data for the vault's price at all.
- `unworded` holds Sky alone under a profile with no `holdingCopy`, so no move in can go.
- `switchUnworded` is `switch` with no `holdingCopy`, so no switch into a vault can go.

The demo builds no account service, so two reads are replaced at the capture boundary: `fixtures/savings.ts` hands the Savings line the demo account's address, and `fixtures/savings-quotes.ts` prices a move at its own vault's price and asset decimals and the fixture's fees in place of an L1 quote. The demo binds no rail either, so the same file asks the engine's `switchTargets` over the rails `moveRails` binds for the fixture's holdings. The selectors, the stores and every view are the wallet's own. `test/dev/captureSavings.test.ts` runs the wallet's holding and price reads over each fixture, and the move sheet's figures over each vault's quote.

These captures show what Savings draws for this state. They do not burn, release, deposit or claim a move, and the plan confirms none.
