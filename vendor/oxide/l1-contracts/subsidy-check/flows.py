"""The mainnet deposit flows that the subsidy check covers, read from the seeds and from gas.json.

A flow is one execution variant (a row of gas.json) of one intent of one forwarding-table row, in an environment whose
profile is on chain 1. Its fee is the row's sweep tip, and its config is the deposit policy of the row's bridge. Its gas
row gives two upper bounds that forge pins: `coverGas`, on the gas that the relayer submits to cover, and `unpricedGas`,
on that gas less the gas that the subsidy prices.
"""

import json
import pathlib
import re
from dataclasses import dataclass

import gas_rows

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROFILES = ROOT / "environments" / "profiles"
SEEDS = ROOT / "environments" / "deployments" / "seeds"
OXIDE_CONSTANTS = ROOT / "l1-contracts" / "src" / "generated" / "OxideConstants.gen.sol"


def oxide_constant(name: str) -> int:
    """A uint constant of OxideConstants, as src/generated/OxideConstants.gen.sol defines it."""
    found = re.search(rf"\buint\d*\s+internal\s+constant\s+{name}\s*=\s*(\d+)\s*;", OXIDE_CONSTANTS.read_text())
    if found is None:
        raise KeyError(f"OxideConstants defines no uint constant {name}")
    return int(found.group(1))


GWEI = 10**9
# The priority fee that the subsidies price on top of the base fee.
MAX_PRIORITY_FEE_WEI = oxide_constant("MAX_PRIORITY_FEE_WEI")
# The highest ETH/USD feed answer (8 decimals) that each flow must be live at. A flow live there is live at every
# lower ETH price (the lower-price argument of README.md, which the lower-price tests sample).
ETH_USD_MAX = 5_000 * 10**8
# The transaction gas price that each flow must be live at: a base fee plus the priority fee that the subsidies pay.
TARGET_WEI = 5 * GWEI + MAX_PRIORITY_FEE_WEI
# The intents that the deposit subsidy model covers. A user operation can make the relayer raise its gas limit, which
# the liveness argument does not cover, so a routed intent outside this list must have a sweep gas ceiling of 0.
INTENTS = ("deposit", "registration")
# Flows that are not live at their target, each with the Linear issue that fixes it. Its corner test asserts the
# shortfall, so a fix makes the check fail until its entry goes.
GAP_FLOWS: dict[str, str] = {
    # The v6-prod DAI deposit config (a 0.1 DAI profit and a 12 DAI cap) does not pay these flows at their target: the
    # profit is less than the cost of their unpriced gas, or the cap is less than the cost of their gas. Thus the fix
    # of another issue alone leaves each of them short. Some of them also have another cause: the DAI-input
    # registrations go over the registration ceiling constant (OX-2320), and DAI already in a USDC or USDT SIPA makes
    # the refund estimate too large, so the subsidy prices too little gas (OX-2327). The gas-row pins fail when either
    # is fixed. When the config pays these flows, a flow that is still short takes the issue of its other cause.
    "v6-prod/dai/deposit/daiDepositFirstSweepUsdcIdleDai": "OX-2405",
    "v6-prod/dai/deposit/daiDepositResweepUsdcIdleDai": "OX-2405",
    "v6-prod/dai/deposit/daiDepositFirstSweepUsdtIdleDai": "OX-2405",
    "v6-prod/dai/deposit/daiDepositResweepUsdtIdleDai": "OX-2405",
    "v6-prod/dai/registration/daiRegistrationFirstSweep": "OX-2405",
    "v6-prod/dai/registration/daiRegistrationSweep": "OX-2405",
    "v6-prod/dai/registration/daiRegistrationFirstSweepUsdc": "OX-2405",
    "v6-prod/dai/registration/daiRegistrationSweepUsdc": "OX-2405",
    "v6-prod/dai/registration/daiRegistrationFirstSweepUsdt": "OX-2405",
    "v6-prod/dai/registration/daiRegistrationSweepUsdt": "OX-2405",
    "v6-prod/dai/registration/daiRegistrationFirstSweepUsdcIdleDai": "OX-2405",
    "v6-prod/dai/registration/daiRegistrationSweepUsdcIdleDai": "OX-2405",
    "v6-prod/dai/registration/daiRegistrationFirstSweepUsdtIdleDai": "OX-2405",
    "v6-prod/dai/registration/daiRegistrationSweepUsdtIdleDai": "OX-2405",
}

# Flows whose measured settlement (test/subsidy-check/fork/DepositSubsidy.settlements.fork.t.sol) is not live at
# the target corner, each with the Linear issue that fixes it. The measured gas is below the bounds of gas.json, so
# this set can be smaller than GAP_FLOWS. Its test asserts the shortfall, so a fix makes the check fail until its
# entry goes.
SETTLEMENT_GAP_FLOWS: dict[str, str] = {
    # The v6-prod DAI deposit config does not pay these flows at the target corner, as in GAP_FLOWS. DAI already in a
    # USDC or USDT SIPA also makes them short (OX-2327).
    "v6-prod/dai/deposit/daiDepositFirstSweepUsdcIdleDai": "OX-2405",
    "v6-prod/dai/deposit/daiDepositResweepUsdcIdleDai": "OX-2405",
    "v6-prod/dai/deposit/daiDepositFirstSweepUsdtIdleDai": "OX-2405",
    "v6-prod/dai/deposit/daiDepositResweepUsdtIdleDai": "OX-2405",
    # A registration's UserOp needs EntryPoint to have more gas than 3/2 of the relay's gas (AA95), so the relayer
    # doubles its gas limit, and its cover becomes about twice the gas that the relay uses. Their tests require that
    # escalation (GAS_LIMIT_ESCALATION_ISSUE), and the other gap tests require that the first gas limit confirms.
    "v6-prod/dai/registration/daiRegistrationFirstSweep": "OX-2325",
    "v6-prod/dai/registration/daiRegistrationSweep": "OX-2325",
    "v6-prod/dai/registration/daiRegistrationFirstSweepUsdc": "OX-2325",
    "v6-prod/dai/registration/daiRegistrationSweepUsdc": "OX-2325",
    "v6-prod/dai/registration/daiRegistrationFirstSweepUsdt": "OX-2325",
    "v6-prod/dai/registration/daiRegistrationSweepUsdt": "OX-2325",
    "v6-prod/dai/registration/daiRegistrationFirstSweepUsdcIdleDai": "OX-2325",
    "v6-prod/dai/registration/daiRegistrationSweepUsdcIdleDai": "OX-2325",
    "v6-prod/dai/registration/daiRegistrationFirstSweepUsdtIdleDai": "OX-2325",
    "v6-prod/dai/registration/daiRegistrationSweepUsdtIdleDai": "OX-2325",
}
# The issue of the settlement gaps where the relayer's first gas limit does not confirm, so the relayer raises it.
GAS_LIMIT_ESCALATION_ISSUE = "OX-2325"
# Flows where a relayer that holds the token gains from relaying its own sweep, at the fork's prices and the real token
# value, each with its Linear issue. Its test asserts the gain.
FARMING_GAP_FLOWS: dict[str, str] = {
    # The deposit subsidy values an sUSDS share at $1, and a share is worth more.
    "v6-prod/susds/deposit/susdsDepositFirstSweep": "OX-2234",
    "v6-prod/susds/deposit/susdsDepositResweep": "OX-2234",
}


@dataclass(frozen=True)
class Flow:
    env: str
    row: str
    intent: str
    variant: str
    fee: int
    profit: int
    cap: int
    cover: int
    unpriced: int
    target: int

    @property
    def id(self) -> str:
        return f"{self.env}/{self.row}/{self.intent}/{self.variant}"

    @property
    def priced(self) -> int:
        return self.cover - self.unpriced


def token_per_eth(usd_per_eth_8: int) -> int:
    """Token units per ETH for an 18-decimal token worth $1, from an ETH/USD answer with 8 decimals."""
    return usd_per_eth_8 * 10**10


def _number(value, what: str, problems: list[str]) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        problems.append(f"{what} is {value!r}, not a number")
        return None


def mainnet_envs() -> list[str]:
    envs = []
    for path in sorted(PROFILES.glob("*.json")):
        if json.loads(path.read_text()).get("chain", {}).get("chainId") == 1:
            envs.append(path.stem)
    return envs


def _bridge(env: str, key: str, tag: str) -> pathlib.Path | None:
    bridges = SEEDS / env / "bridges"
    default = bridges / f"brg-{key}-{tag}.json"
    if default.exists():
        return default
    found = sorted(bridges.glob(f"brg-{key}-*.json"))
    return found[0] if len(found) == 1 else None


def sweep_gas_ceilings(env: str) -> dict[str, int] | None:
    """The sweep gas ceiling of each intent in the env's name-core seed, or None without exactly one name core."""
    cores = sorted((SEEDS / env / "name-cores").glob("*.json"))
    if len(cores) != 1:
        return None
    ceilings = json.loads(cores[0].read_text())["deployment"]["sweepGasCeilings"]
    return {intent: int(gas) for intent, gas in ceilings.items()}


def flows() -> tuple[list[Flow], list[str], list[str]]:
    """Each mainnet flow, the problems that leave a flow unchecked, and notes for the log."""
    gas = gas_rows.rows()
    found, problems, notes = [], [], []
    for env in mainnet_envs():
        tables = sorted((SEEDS / env / "forwarding-tables").glob("ftb-*.json"))
        if not tables:
            notes.append(f"{env}: no routes (no forwarding table)")
            continue
        ceilings = sweep_gas_ceilings(env)
        if ceilings is None:
            problems.append(f"{env}: no single name-core seed gives the sweep gas ceilings")
            continue
        for table in tables:
            tag = table.stem.removeprefix("ftb-")
            for key, row in json.loads(table.read_text())["rows"].items():
                for intent, fees in row["intents"].items():
                    where = f"{env} {table.name} row {key} {intent}"
                    if ceilings.get(intent, 0) == 0:
                        notes.append(f"{where}: no subsidy (sweep gas ceiling 0)")
                        continue
                    if intent not in INTENTS:
                        problems.append(f"{where}: the liveness model covers only {', '.join(INTENTS)}")
                        continue
                    bridge = _bridge(env, key, tag)
                    if bridge is None:
                        problems.append(f"{where}: no bridge seed brg-{key}-{tag}.json")
                        continue
                    policy = json.loads(bridge.read_text())["policies"]["deposits"]
                    fee = _number(fees["sweepTip"], f"{where} sweepTip", problems)
                    profit = _number(policy["targetRelayerProfit"], f"{bridge.name} targetRelayerProfit", problems)
                    cap = _number(policy["maxSubsidyPerOperation"], f"{bridge.name} maxSubsidyPerOperation", problems)
                    variants = {v: g for v, g in gas.items() if g["row"] == key and g["intent"] == intent}
                    if not variants:
                        problems.append(f"{where}: no gas row in gas.json. Add one, with its forge pin")
                    if None in (fee, profit, cap):
                        continue
                    for variant, g in sorted(variants.items()):
                        found.append(
                            Flow(
                                env,
                                key,
                                intent,
                                variant,
                                fee,
                                profit,
                                cap,
                                int(g["coverGas"]),
                                int(g["unpricedGas"]),
                                TARGET_WEI,
                            )
                        )
    return found, problems, notes
