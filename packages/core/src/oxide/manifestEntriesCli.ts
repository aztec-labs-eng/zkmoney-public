import { oxideManifestEntries } from "./index.js"

try {
  process.stdin.setEncoding("utf8")
  let body = ""
  for await (const chunk of process.stdin) body += chunk
  process.stdout.write(JSON.stringify(oxideManifestEntries(JSON.parse(body))))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
