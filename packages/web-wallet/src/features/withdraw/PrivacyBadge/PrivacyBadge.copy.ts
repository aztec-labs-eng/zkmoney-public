export default {
  questions: {
    used: {
      question: "Used with zk.money?",
      body: "Sending to a wallet you deposited from links the two.",
    },
    transactions: {
      question: "Has transactions?",
      body: "An address with no history has nothing to link to.",
    },
    named: {
      question: "Publicly named?",
      body: "ENS names, exchanges and known apps show who receives.",
    },
  },
  /** Each segment's answer, by the tone it found. */
  answers: {
    deposited: "Deposited from here",
    withdrew: "Withdrew here {n}×",
    withdrewUncounted: "Withdrew to it",
    notUsed: "No",
    transactions: { direct: "Yes", weak: "Yes", clear: "No", unknown: "Unknown" },
    named: "Yes",
    notNamed: "No",
  },
  /** The popover's one line: its worst finding, or none. */
  headline: {
    deposited: "Used with zk.money",
    withdrew: "Used {n}× with zk.money",
    withdrewUncounted: "Withdrew to it before",
    transactions: "Has transactions",
    named: "Publicly named",
    unknown: "Couldn't check its history",
    clear: "No links found",
  },
  etherfiName: "App · ether.fi",
  rated: "How privacy is rated",
  fresh: "Use a fresh address",
  close: "Close",
  ratedBody: "The ring rates the privacy level of each segment by answering a specific question.",
  legend: { clear: "Clear", weak: "At risk", direct: "Exposed" },
  /** A rated address's privacy level. */
  level: { High: "High", Medium: "Medium", Low: "Low" },
  /** How the segments add up to each level. */
  rule: { High: "3 green", Medium: "1 or more yellow", Low: "1 or more red" },
  gotIt: "Got it",
} as const
