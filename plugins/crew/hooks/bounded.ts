// Capped insertion-order records: a key or value written again moves to the newest place, and past the cap the oldest
// entries go. Pure: the caller owns the map or set and its cap.

/** Writes `key` as the newest entry of `map`, then drops the oldest entries while there are more than `cap`. */
export function keepLatest<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > cap) map.delete(map.keys().next().value as K)
}

/** Adds `value` as the newest entry of `set`, then drops the oldest entries while there are more than `cap`. */
export function keepLatestIn<T>(set: Set<T>, value: T, cap: number): void {
  set.delete(value)
  set.add(value)
  while (set.size > cap) set.delete(set.values().next().value as T)
}
