import { pinnedOxideDeployment } from "./index.js"
import { profileHoldingsProblems, unwordedHoldings } from "./profileHoldings.js"

// stdin: { manifest, portal, portals?, holdings?, holdingCopy? }. Prints each problem and fails
// when the pinned deployment cannot carry the profile's portals and holdings, or a holding the
// wallet lists has no words.
try {
  process.stdin.setEncoding("utf8")
  let body = ""
  for await (const chunk of process.stdin) body += chunk
  const { manifest, portal, ...profile } = JSON.parse(body)
  const pinned = pinnedOxideDeployment(manifest, { portal })
  const problems = [
    ...profileHoldingsProblems(pinned.deployment, profile),
    ...unwordedHoldings(pinned, profile).map((id) => `holding ${id} has no words in holdingCopy`),
  ]
  for (const problem of problems) process.stderr.write(`${problem}\n`)
  if (problems.length > 0) process.exitCode = 1
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
