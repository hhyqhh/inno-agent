// Framework-agnostic typed EventEmitter base class.
// No Lit, no React — pure TypeScript.
// Lit components subscribe in connectedCallback / unsubscribe in disconnectedCallback.
// React migration: wrap with useSyncExternalStore or custom useStore hook.

export type Listener<T> = (data: T) => void;

// biome-ignore lint: generic constraint for event map
export class EventEmitter<Events> {
	private _listeners = new Map<keyof Events, Set<Listener<any>>>();

	on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
		let set = this._listeners.get(event);
		if (!set) {
			set = new Set();
			this._listeners.set(event, set);
		}
		set.add(fn);
		// Return unsubscribe function
		return () => {
			set!.delete(fn);
		};
	}

	protected emit<K extends keyof Events>(event: K, data: Events[K]): void {
		const set = this._listeners.get(event);
		if (set) {
			for (const fn of set) {
				fn(data);
			}
		}
	}
}
