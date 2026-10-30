/** A small three-way protocol: disk is authoritative for untouched keys.
 * Pending writes retain the value they were based on, so a stale instance
 * cannot restore a deleted key merely by flushing an unrelated mutation.
 */
export interface StateChange<T> {
  base: string | undefined
  value: T | undefined
}

export function fingerprint(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value)
}

export function changesFrom<T>(
  base: Record<string, T>,
  current: Record<string, T>,
): Map<string, StateChange<T>> {
  const changes = new Map<string, StateChange<T>>()
  for (const key of new Set([...Object.keys(base), ...Object.keys(current)])) {
    if (fingerprint(base[key]) !== fingerprint(current[key])) {
      changes.set(key, { base: fingerprint(base[key]), value: current[key] })
    }
  }
  return changes
}

export function reconcile<T>(
  disk: Record<string, T>,
  changes: ReadonlyMap<string, StateChange<T>>,
  newer?: (candidate: T, current: T) => boolean,
): Record<string, T> {
  const result = { ...disk }
  for (const [key, change] of changes) {
    const current = result[key]
    if (change.value === undefined) {
      // An explicit removal wins within its reset epoch.
      delete result[key]
    } else if (
      fingerprint(current) === change.base ||
      (current !== undefined && newer?.(change.value, current))
    ) {
      result[key] = change.value
    }
    // In particular: base existed + disk absent => reject stale update.
  }
  return result
}
