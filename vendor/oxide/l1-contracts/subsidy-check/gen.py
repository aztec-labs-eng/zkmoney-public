"""Writes the forge tests that the subsidy check generates from gas.json and the seeds.

- test/subsidy-check/subsidies/DepositSubsidy.flowCorners.t.sol: for each mainnet flow (flows.py), a test that runs the
  production quote at the flow's gas bounds and seed config, at its target gas price and ETH at $5,000. A live flow must
  clear the executor's required payout by 1 token-wei. A known gap (flows.GAP_FLOWS) asserts its shortfall instead,
  and its test's name carries its issue.
- test/subsidy-check/fork/DepositSubsidy.gasRows.fork.t.sol: the fork pin of each gas row (gas_rows.pin_test), and the
  staging of each row, in the order that the measurements need: the deposit rows, then the registration rows.
- test/subsidy-check/fork/DepositSubsidy.settlements.fork.t.sol: for each mainnet flow, a settlement of its gas row on the fork at
  the production config through the relayer's cover rule, with the decision at the target corner on the measured
  chain gas (flows.SETTLEMENT_GAP_FLOWS asserts a shortfall), and a relay by a relayer that holds the token, which
  must gain nothing (flows.FARMING_GAP_FLOWS asserts a gain).

Run: python3 -I gen.py           writes the files.
     python3 -I gen.py --check   fails when a file is stale, when a routed flow or a gas row has no check, or when two
                                 forwarding tables of an env route one row, so that two flows have one test name.
"""

import difflib
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import flows  # noqa: E402
import gas_rows  # noqa: E402

L1 = HERE.parent
CORNERS = L1 / "test" / "subsidy-check" / "subsidies" / "DepositSubsidy.flowCorners.t.sol"
PINS = L1 / gas_rows.PINS
SETTLEMENTS = L1 / "test" / "subsidy-check" / "fork" / "DepositSubsidy.settlements.fork.t.sol"
CORNER_SUITE = "DepositSubsidyFlowCornersTest"
PIN_SUITE = gas_rows.PIN_SUITE
SETTLEMENT_SUITE = "DepositSubsidySettlementsForkTest"
SETTLEMENT_ENV = "v6-prod"
STAGED_INTENTS = ("deposit", "registration")
HEADER = "// SPDX-License-Identifier: Apache-2.0\npragma solidity >=0.8.27;\n"
# The fork suites measure each relay as its own transaction, as the chain charges it.
ISOLATE = "/// forge-config: default.isolate = true"


def flow_name(f: flows.Flow) -> str:
    return f"{f.env.replace('-', '')}_{f.variant}"


def corner_test(f: flows.Flow) -> str:
    gap = flows.GAP_FLOWS.get(f.id)
    if gap is None:
        return f"test_Flow_{flow_name(f)}_IsLiveAtItsTarget"
    return f"test_Gap_{gap.replace('-', '')}_{flow_name(f)}_IsShortAtItsTarget"


def settlement_test(f: flows.Flow) -> str:
    gap = flows.SETTLEMENT_GAP_FLOWS.get(f.id)
    if gap is None:
        return f"test_Settle_{flow_name(f)}_IsLiveAtTheCorner"
    return f"test_Gap_{gap.replace('-', '')}_{flow_name(f)}_SettlesButIsShortAtTheCorner"


def farming_test(f: flows.Flow) -> str:
    gap = flows.FARMING_GAP_FLOWS.get(f.id)
    if gap is None:
        return f"test_Farm_{flow_name(f)}_GainsNothing"
    return f"test_Gap_{gap.replace('-', '')}_{flow_name(f)}_Farms"


def number(n: int) -> str:
    """A literal that forge fmt keeps: a power-of-ten form for a round amount, else digits in groups of three."""
    if n >= 10**6:
        mantissa, exponent = n, 0
        while mantissa % 10 == 0:
            mantissa, exponent = mantissa // 10, exponent + 1
        if exponent >= 6 and mantissa < 10**4:
            return f"{mantissa}e{exponent}"
    return f"{n:_}" if n >= 10**4 else str(n)


def gwei(n: int) -> str:
    return f"{n / 10**9:g} gwei" if n % 10**7 == 0 else number(n)


def corners_source(found: list[flows.Flow]) -> str:
    out = [
        HEADER,
        'import {DepositSubsidyFlowCorners} from "@test/subsidy-check/subsidies/DepositSubsidyFlowCorners.sol";',
        "",
        f"contract {CORNER_SUITE} is DepositSubsidyFlowCorners {{",
    ]
    for f in found:
        constants = f"_{flow_name(f)}()"
        if f.id in flows.GAP_FLOWS:
            out += [f"  function {corner_test(f)}() external {{", f"    _assertShortAtTheTarget({constants});", "  }", ""]
        else:
            out += [f"  function {corner_test(f)}() external {{", f"    _assertLiveAtTheTarget({constants});", "  }", ""]
        values = [number(v) for v in (f.fee, f.profit, f.cap, f.cover, f.unpriced)]
        values += [gwei(f.target), f"{flows.ETH_USD_MAX // 10**8}e8"]
        out += [
            f"  function {constants[:-2]}() internal pure returns (Flow memory) {{",
            f"    return _flow({', '.join(values)});",
            "  }",
            "",
        ]
    out[-1] = "}"
    return "\n".join(out) + "\n"


def staged_rows(rows: dict[str, dict]) -> list[str]:
    """The gas rows in staging order: the deposit rows, then the registration rows, each in gas.json order."""
    return [name for intent in STAGED_INTENTS for name, g in rows.items() if g["intent"] == intent]


def pins_source(rows: dict[str, dict]) -> str:
    out = [
        HEADER,
        'import {DepositSubsidyGasRowsFixture} from "@test/subsidy-check/fork/DepositSubsidyGasRowsFixture.sol";',
        "",
        ISOLATE,
        f"contract {PIN_SUITE} is DepositSubsidyGasRowsFixture {{",
        "  function _stageRows() internal override {",
        *(f'    _stageRow("{name}");' for name in staged_rows(rows)),
        "  }",
        "",
    ]
    for name in rows:
        out += [f"  function {gas_rows.pin_test(name)}() external {{", f'    _checkRow("{name}");', "  }", ""]
    out[-1] = "}"
    return "\n".join(out) + "\n"


def settlements_source(found: list[flows.Flow], rows: dict[str, dict]) -> str:
    out = [
        HEADER,
        'import {DepositSubsidySettlementsFixture} from "@test/subsidy-check/fork/DepositSubsidySettlementsFixture.sol";',
        "",
        ISOLATE,
        f"contract {SETTLEMENT_SUITE} is DepositSubsidySettlementsFixture {{",
        "  function _stageRows() internal override {",
        *(f'    _stageRow("{name}");' for name in staged_rows(rows)),
        "  }",
        "",
    ]
    for f in found:
        gap = flows.SETTLEMENT_GAP_FLOWS.get(f.id)
        if gap is None:
            settle = f'_assertLiveAtTheCorner("{f.variant}")'
        else:
            escalates = "true" if gap == flows.GAS_LIMIT_ESCALATION_ISSUE else "false"
            settle = f'_assertShortAtTheCorner("{f.variant}", {escalates})'
        farm = "_assertFarms" if f.id in flows.FARMING_GAP_FLOWS else "_assertGainsNothing"
        out += [f"  function {settlement_test(f)}() external {{", f"    {settle};", "  }", ""]
        out += [f"  function {farming_test(f)}() external {{", f'    {farm}("{f.variant}");', "  }", ""]
    out[-1] = "}"
    return "\n".join(out) + "\n"


def problems(found: list[flows.Flow], flow_problems: list[str], rows: dict[str, dict]) -> list[str]:
    out = list(flow_problems)
    ids = [f.id for f in found]
    for twice in sorted({i for i in ids if ids.count(i) > 1}):
        env, row = twice.split("/")[:2]
        out.append(
            f"two forwarding tables of {env} route the row {row}, so the flow {twice} has two tests with one name. "
            "Route each row in one table of the env"
        )
    for gaps, name in ((flows.GAP_FLOWS, "GAP_FLOWS"), (flows.SETTLEMENT_GAP_FLOWS, "SETTLEMENT_GAP_FLOWS"),
                       (flows.FARMING_GAP_FLOWS, "FARMING_GAP_FLOWS")):  # fmt: skip
        for stale in sorted(gaps.keys() - {f.id for f in found}):
            out.append(f"flows.{name} names {stale}, which is not a mainnet flow")
    for f in found:
        if f.env != SETTLEMENT_ENV:
            out.append(f"{f.id}: the settlement fixture stages the {SETTLEMENT_ENV} contracts, not {f.env}'s")
    for name, g in rows.items():
        if g["intent"] not in STAGED_INTENTS:
            out.append(f"gas.json: {name} has the intent {g['intent']}, which the fork fixture cannot stage")
    return out + gas_rows.state_problems(rows)


def outputs() -> tuple[dict[pathlib.Path, str], list[str]]:
    found, flow_problems, _ = flows.flows()
    rows = gas_rows.rows()
    files = {CORNERS: corners_source(found), PINS: pins_source(rows), SETTLEMENTS: settlements_source(found, rows)}
    return files, problems(found, flow_problems, rows)


def main() -> int:
    check = "--check" in sys.argv[1:]
    files, found = outputs()
    for problem in found:
        print(f"gen.py: {problem}", file=sys.stderr)
    stale = 0
    for path, text in files.items():
        current = path.read_text() if path.exists() else ""
        if current == text:
            continue
        if check:
            stale += 1
            print(f"gen.py: {path.relative_to(L1)} is stale. Run python3 -I subsidy-check/gen.py", file=sys.stderr)
            sys.stderr.writelines(
                difflib.unified_diff(current.splitlines(True), text.splitlines(True), "committed", "generated", n=1)
            )
        else:
            path.write_text(text)
            print(f"gen.py: wrote {path.relative_to(L1)}")
    return 1 if found or stale else 0


if __name__ == "__main__":
    sys.exit(main())
