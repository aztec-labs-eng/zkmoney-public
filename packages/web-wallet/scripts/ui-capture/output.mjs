import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"

export function outputPath(root, file) {
  const target = path.resolve(root, file)
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`Output path escapes its directory: ${file}`)
  }
  return target
}

export async function externalOutputDir(directory, repo) {
  const source = await realpath(repo)
  let ancestor = path.resolve(directory)
  const missing = []
  while (true) {
    try { await lstat(ancestor); break }
    catch (error) {
      if (error.code !== "ENOENT") throw error
      missing.unshift(path.basename(ancestor))
      ancestor = path.dirname(ancestor)
    }
  }
  // Resolve the existing ancestor before mkdir can create anything inside source.
  const target = path.resolve(await realpath(ancestor), ...missing)
  if (target === source || target.startsWith(`${source}${path.sep}`)) {
    throw new Error("Generated capture output must be outside the repository")
  }
  await mkdir(target, { recursive: true })
  if ((await readdir(target)).length) throw new Error("Capture output must be an empty directory; use a new --output-dir")
  return target
}

export async function outputDirectory(root, directory) {
  const target = outputPath(root, directory)
  if (await realpath(root) !== path.resolve(root)) throw new Error(`Output directory contains a symlink: ${root}`)
  let current = root
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part)
    try { await mkdir(current) }
    catch (error) { if (error.code !== "EEXIST") throw error }
    const entry = await lstat(current)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Output directory must not be a symlink or file: ${current}`)
  }
  return target
}

export async function writeOutputFile(root, file, data) {
  const target = outputPath(root, file)
  const parent = path.relative(root, path.dirname(target))
  if (parent) await outputDirectory(root, parent)
  if (await realpath(path.dirname(target)) !== path.dirname(target)) {
    throw new Error(`Output path contains a symlink: ${target}`)
  }
  // Exclusive creation also rejects existing file symlinks and hard links without following them.
  await writeFile(target, data, { flag: "wx" })
  return target
}
