/** Runs each call once the one before it settled, whatever its outcome. */
export type Turn = <T>(run: () => Promise<T>) => Promise<T>

export function createTurn(): Turn {
  let last: Promise<unknown> = Promise.resolve()
  return (run) => {
    const next = last.then(run)
    last = Promise.allSettled([next])
    return next
  }
}

/** A {@link Turn} per key. */
export type KeyedTurn = <T>(key: string, run: () => Promise<T>) => Promise<T>

export function createKeyedTurn(): KeyedTurn {
  const turns = new Map<string, Turn>()
  return (key, run) => {
    const turn = turns.get(key) ?? createTurn()
    turns.set(key, turn)
    return turn(run)
  }
}
