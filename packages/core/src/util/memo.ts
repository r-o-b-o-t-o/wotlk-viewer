/**
 * Returns the cached promise for `key`, starting `make()` on the first call.
 * A rejected promise is evicted so the next call retries instead of replaying the failure.
 */
export function memo<K, V>(cache: Map<K, Promise<V>>, key: K, make: () => Promise<V>): Promise<V> {
	let p = cache.get(key);
	if (!p) {
		p = make();
		cache.set(key, p);
		p.catch(() => cache.delete(key));
	}
	return p;
}
