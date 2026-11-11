import { createElement, Fragment, type ReactNode } from "react"

/** The `{name}` placeholders a copy string holds, read from its literal type. */
export type Placeholders<T extends string> = T extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never

type Vars<T extends string, V = string | number> = [Placeholders<T>] extends [never]
  ? []
  : [vars: Record<Placeholders<T>, V>]

/** A copy string with its placeholders filled; a missing or unknown one is a type error. */
export function fmt<T extends string>(template: T, ...[vars]: Vars<T>): string {
  if (!vars) return template
  const values = vars as Record<string, string | number>
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  )
}

/** `fmt` for placeholders filled with React nodes, such as a bold figure inside a sentence. */
export function fmtNodes<T extends string>(template: T, ...[vars]: Vars<T, ReactNode>): ReactNode {
  if (!vars) return template
  const values = vars as Record<string, ReactNode>
  const parts = template
    .split(/\{(\w+)\}/g)
    .map((part, i) => (i % 2 === 0 ? part : part in values ? values[part] : `{${part}}`))
  return createElement(Fragment, null, ...parts)
}
