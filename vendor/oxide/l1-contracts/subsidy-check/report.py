"""The config report: for each mainnet flow, the gas of its relay on the fork and its limits under the config.

It runs the gas-row pins and the settlements (test/subsidy-check/fork/DepositSubsidy.{gasRows,settlements}.fork.t.sol) with
`forge test --json`, reads their logs, and prints one table row for each flow:

- the measured relay, which is the zero-cover execution that the relayer simulates first: the gross gas, the refund
  that the meter estimates and the refund that the EVM gave (`vm.lastCallGas().gasRefunded`), the gas that the
  transaction is charged, the gas that the subsidy priced, and their difference, on the fork;
- the chain gas at the corner: the cover gas, the priced gas, the unpriced gas, the relayer's gas limit raises, and
  the token cost at the target corner;
- the highest gas price at which the flow is live at its gas bounds, at ETH $5,000 and at the fork's ETH price, and the
  smallest cap and profit that make it live at its target. A search over the integer formula of `_quoteSubsidy` gives
  these.

The report checks its formula against the production quote: at each flow's corner, the formula must give the payout and
the required payout that the settlement logged, and at the gas bounds it must give the live or gap split of the corner
tests. A relayer that holds the token priced at most the gas that its transaction used (the gas-row pin) is listed
apart, as the meter's margin, not as an underpricing budget.

It fails when forge fails or a test does not pass, when a flow has no settlement logs or a gas row has no pin logs,
or when its formula does not give the production quote.

Run: python3 -I report.py [--results FILE]   (from l1-contracts/subsidy-check, with aztec-forge on PATH)
"""

import argparse
import json
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import flows  # noqa: E402

L1 = HERE.parent
WAD = 10**18
GWEI = 10**9
FEED_TO_TOKEN_WEI = 10**10
STEP = WAD // 100
FORK_TESTS = "test/subsidy-check/fork/DepositSubsidy.{gasRows,settlements}.fork.t.sol"
PAIR = re.compile(r"([a-z][a-z -]*?) (\d+)")
SETTLEMENT_LOGS = (
    "zero-cover gas",
    "zero-cover gross",
    "zero-cover refund",
    "estimated refund",
    "fork priced",
    "chain cover",
    "chain priced",
    "escalations",
    "corner payout",
    "corner required",
)


def quote(fee: int, priced: int, token_per_eth: int, profit: int, cap: int, pot: int, gas_price: int) -> int:
    """The integer formula of DepositSubsidy._quoteSubsidy, at a gas price that the subsidy prices whole."""
    if priced == 0:
        return 0
    cost = priced * gas_price * token_per_eth // WAD
    target = cost + min(profit, fee)
    if target <= fee:
        return 0
    return min(target - fee, cap, pot)


def required(cover: int, gas_price: int, token_per_eth: int) -> int:
    return -(-cover * gas_price * token_per_eth // WAD)


def live(f: flows.Flow, gas_price: int, usd_per_eth_8: int, cap: int | None = None, profit: int | None = None) -> bool:
    cap = f.cap if cap is None else cap
    profit = f.profit if profit is None else profit
    r = usd_per_eth_8 * FEED_TO_TOKEN_WEI
    return f.fee + quote(f.fee, f.priced, r, profit, cap, cap, gas_price) >= required(f.cover, gas_price, r) + 1


def gas_limit(f: flows.Flow, usd_per_eth_8: int) -> int:
    lo, hi = 0, 1000 * GWEI
    while hi - lo > 10**6:
        mid = (lo + hi) // 2
        lo, hi = (mid, hi) if live(f, mid, usd_per_eth_8) else (lo, mid)
    return lo


def smallest(f: flows.Flow, field: str, ceiling: int) -> int | None:
    def ok(value: int) -> bool:
        return live(f, f.target, flows.ETH_USD_MAX, **{field: value})

    if not ok(ceiling):
        return None
    lo, hi = 0, ceiling // STEP
    while lo < hi:
        mid = (lo + hi) // 2
        lo, hi = (lo, mid) if ok(mid * STEP) else (mid + 1, hi)
    return lo * STEP


def logs_by_row(raw: dict, prefix: str) -> dict[str, dict[str, int]]:
    """The logged values of each row, from the log lines after `<prefix> <row>`."""
    found: dict[str, dict[str, int]] = {}
    for suite in raw.values():
        for test in suite["test_results"].values():
            row = None
            for line in test.get("decoded_logs") or []:
                text = line.strip()
                if text.startswith(prefix + " "):
                    row = text[len(prefix) + 1 :]
                    found.setdefault(row, {})
                elif row is not None:
                    for name, value in PAIR.findall(text):
                        found[row][name.strip()] = int(value)
    return found


def gas_row_logs(raw: dict) -> dict[str, dict[str, int]]:
    """The holder relay of each gas-row pin: its transaction gas and its priced gas."""
    found = {}
    for suite in raw.values():
        for test in suite["test_results"].values():
            logs = [line.strip() for line in test.get("decoded_logs") or []]
            for i, line in enumerate(logs):
                if line.startswith("holder: tx gas") and i + 1 < len(logs):
                    values = dict((n.strip(), int(v)) for n, v in PAIR.findall(line))
                    found[logs[i + 1]] = {"holder tx gas": values.get("holder: tx gas", values.get("tx gas")),
                                          "holder priced": values.get("priced")}  # fmt: skip
    return found


def fork_eth_usd_8(settled: dict[str, int], f: flows.Flow) -> int | None:
    """The fork's ETH price, from a settlement whose subsidy the cap did not bind: subsidy = cost of its priced gas."""
    priced, payout = settled.get("fork priced"), settled.get("simulated payout")
    if not priced or not payout:
        return None
    cost = payout - min(f.profit, f.fee)
    return cost * WAD // (priced * (5 * GWEI + flows.MAX_PRIORITY_FEE_WEI) * FEED_TO_TOKEN_WEI)


def forge_problems(raw) -> list[str]:
    """A line for each suite or test in the results that did not pass."""
    if not isinstance(raw, dict) or not raw:
        return ["forge: the results have no suites"]
    found = []
    for suite_id, suite in sorted(raw.items()):
        for signature, test in sorted((suite.get("test_results") or {}).items()):
            if test.get("status") != "Success":
                found.append(f"forge: {suite_id} {signature}: {test.get('status')} ({test.get('reason')})")
    return found


def tokens(n: int | None) -> str:
    return "-" if n is None else f"{n / WAD:.2f}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", type=pathlib.Path)
    args = parser.parse_args()
    errors = []
    if args.results is None:
        proc = subprocess.run(
            ["aztec-forge", "test", "--json", "-vv", "--match-path", FORK_TESTS], cwd=L1, capture_output=True, text=True
        )
        if proc.returncode != 0:
            errors.append(f"forge: exit {proc.returncode}: {proc.stderr.strip()[-500:]}")
        text = proc.stdout
    else:
        text = args.results.read_text()
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        for error in errors or ["forge: the output is not JSON"]:
            print(f"report.py: {error}", file=sys.stderr)
        return 1
    errors += forge_problems(raw)
    settlements = logs_by_row(raw, "settlement") if isinstance(raw, dict) else {}
    pins = gas_row_logs(raw) if isinstance(raw, dict) else {}
    found, problems, _ = flows.flows()
    errors += problems
    for row in sorted(json.loads((HERE / "gas.json").read_text())["rows"].keys() - pins.keys()):
        errors.append(f"{row}: the gas-row pin logged no holder relay")
    eth_fork = next((e for f in found if (e := fork_eth_usd_8(settlements.get(f.variant, {}), f))), None)

    print("| Flow | Gross | Refund est. / actual | Charged | Priced | Unpriced (fork) | Chain cover | Chain priced |"
          " Raises | Corner cost | Live to (gwei), $5,000 / fork ETH | Min cap | Min profit |")  # fmt: skip
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for f in found:
        s = settlements.get(f.variant, {})
        missing = [name for name in SETTLEMENT_LOGS if name not in s]
        if missing:
            errors.append(f"{f.id}: its settlement did not log {', '.join(missing)}")
        charged, priced = s.get("zero-cover gas"), s.get("fork priced")
        corner_cost = None
        if "chain cover" in s and "chain priced" in s:
            corner = flows.ETH_USD_MAX * FEED_TO_TOKEN_WEI
            corner_cost = required(s["chain cover"], f.target, corner)
            payout = f.fee + quote(f.fee, s["chain priced"], corner, f.profit, f.cap, 2**128, f.target)
            if (payout, corner_cost + 1) != (s.get("corner payout"), s.get("corner required")):
                errors.append(f"{f.id}: the formula gives {payout}, {corner_cost + 1} at the corner, the production "
                              f"quote {s.get('corner payout')}, {s.get('corner required')}")  # fmt: skip
        if live(f, f.target, flows.ETH_USD_MAX) == (f.id in flows.GAP_FLOWS):
            errors.append(f"{f.id}: the formula and flows.GAP_FLOWS disagree at the gas bounds")
        unpriced_fork = None if charged is None or priced is None else charged - priced
        limit_fork = "-" if eth_fork is None else f"{gas_limit(f, eth_fork) / GWEI:.3f}"
        print(
            f"| {f.variant} | {s.get('zero-cover gross', '-')} | {s.get('estimated refund', '-')} / "
            f"{s.get('zero-cover refund', '-')} | "
            f"{charged or '-'} | {priced or '-'} | {unpriced_fork if unpriced_fork is not None else '-'} | "
            f"{s.get('chain cover', '-')} | {s.get('chain priced', '-')} | {s.get('escalations', '-')} | "
            f"{tokens(corner_cost)} | {gas_limit(f, flows.ETH_USD_MAX) / GWEI:.3f} / {limit_fork} | "
            f"{tokens(smallest(f, 'cap', 1000 * WAD))} | {tokens(smallest(f, 'profit', f.fee))} |"
        )
    print()
    print("A relayer that holds the token (the gas-row pins): the priced gas is at most the gas that the transaction used.")
    print()
    print("| Gas row | Tx gas | Priced | Margin |")
    print("| --- | ---: | ---: | ---: |")
    for row, p in pins.items():
        print(f"| {row} | {p['holder tx gas']} | {p['holder priced']} | {p['holder tx gas'] - p['holder priced']} |")
    if eth_fork is not None:
        print(f"\nThe fork's ETH price: ${eth_fork / 10**8:,.2f}.")
    for error in errors:
        print(f"report.py: {error}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
