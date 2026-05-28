import { useEffect, useRef, useState } from "react";

type ChangeStore = {
	on(event: "change", fn: () => void): () => void;
};

export function useStoreSnapshot<TStore extends ChangeStore, TSnapshot>(
	store: TStore,
	getSnapshot: () => TSnapshot,
): TSnapshot {
	const getSnapshotRef = useRef(getSnapshot);
	const [snapshot, setSnapshot] = useState(getSnapshot);
	getSnapshotRef.current = getSnapshot;

	useEffect(() => {
		setSnapshot(getSnapshotRef.current());
		return store.on("change", () => {
			setSnapshot(getSnapshotRef.current());
		});
	}, [store]);

	return snapshot;
}
