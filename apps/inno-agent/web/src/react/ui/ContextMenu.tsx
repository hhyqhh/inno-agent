import { useEffect, type ReactNode } from "react";

export interface ContextMenuItem {
	label: ReactNode;
	onSelect: () => void;
	danger?: boolean;
}

interface ContextMenuProps {
	x: number;
	y: number;
	items: ContextMenuItem[];
	onClose: () => void;
}

/** Shared fixed-position context menu used by workspace files and attachments. */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	return (
		<>
			<div
				className="fixed inset-0 z-40"
				aria-hidden="true"
				onClick={(event) => { event.stopPropagation(); onClose(); }}
				onContextMenu={(event) => event.stopPropagation()}
			/>
			<div
				className="inno-smart-menu"
				style={{ left: x, top: y }}
				onClick={(event) => event.stopPropagation()}
				onContextMenu={(event) => event.stopPropagation()}
			>
				{items.map((item, index) => (
					<button
						key={index}
						type="button"
						className={`inno-smart-menu-item ${item.danger ? "is-danger" : ""}`}
						onClick={() => {
							item.onSelect();
							onClose();
						}}
					>
						{item.label}
					</button>
				))}
			</div>
		</>
	);
}
