import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, FilePlus2, LayoutTemplate, LoaderCircle, Plus, Settings2 } from "lucide-react";
import { noteTemplateStore } from "../../stores/note-template-store.js";
import { useStoreSnapshot } from "../hooks.js";

interface TemplateMenuProps {
	isCreating: boolean;
	onCreateBlank(): void;
	onUseTemplate(id: string): void;
	onCreateTemplate(): void;
	onManageTemplates(): void;
}

interface MenuPosition {
	left: number;
	top?: number;
	bottom?: number;
	maxHeight: number;
}

const MENU_WIDTH = 272;
const MENU_MAX_HEIGHT = 460;
const MENU_GAP = 4;
const VIEWPORT_PADDING = 8;

export function TemplateMenu({ isCreating, onCreateBlank, onUseTemplate, onCreateTemplate, onManageTemplates }: TemplateMenuProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const state = useStoreSnapshot(noteTemplateStore, () => ({
		templates: noteTemplateStore.templates.filter((template) => template.id !== "blank" && (template.source === "custom" || !template.hidden)),
		isLoading: noteTemplateStore.isLoading,
	}));

	useEffect(() => { void noteTemplateStore.load(); }, []);
	useEffect(() => {
		if (!open) return;
		const close = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", close, true);
		return () => document.removeEventListener("pointerdown", close, true);
	}, [open]);
	useLayoutEffect(() => {
		if (!open) {
			setMenuPosition(null);
			return;
		}

		const updatePosition = () => {
			const anchor = rootRef.current?.getBoundingClientRect();
			if (!anchor) return;

			const left = Math.min(
				Math.max(VIEWPORT_PADDING, anchor.left),
				Math.max(VIEWPORT_PADDING, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING),
			);
			const availableBelow = window.innerHeight - anchor.bottom - MENU_GAP - VIEWPORT_PADDING;
			const availableAbove = anchor.top - MENU_GAP - VIEWPORT_PADDING;
			const openBelow = availableBelow >= Math.min(MENU_MAX_HEIGHT, availableAbove);
			const availableHeight = Math.max(120, openBelow ? availableBelow : availableAbove);

			setMenuPosition({
				left,
				...(openBelow
					? { top: anchor.bottom + MENU_GAP }
					: { bottom: window.innerHeight - anchor.top + MENU_GAP }),
				maxHeight: Math.min(MENU_MAX_HEIGHT, availableHeight, window.innerHeight * 0.7),
			});
		};

		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [open]);

	const custom = state.templates.filter((template) => template.source === "custom");
	const system = state.templates.filter((template) => template.source === "system");
	const renderGroup = (label: string, templates: typeof state.templates) => templates.length > 0 ? (
		<div className="py-1">
			<div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--inno-text-subtle)]">{label}</div>
			{templates.map((template) => (
				<button
					key={template.id}
					type="button"
					className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--inno-surface-muted)]"
					onClick={() => { setOpen(false); onUseTemplate(template.id); }}
				>
					<LayoutTemplate size={14} className="mt-0.5 shrink-0 text-[var(--inno-accent)]" />
					<span className="min-w-0 flex-1">
						<span className="block truncate text-xs font-medium text-[var(--inno-text)]">{template.label}</span>
						{template.description ? <span className="mt-0.5 line-clamp-2 block text-[10px] leading-4 text-[var(--inno-text-muted)]">{template.description}</span> : null}
					</span>
					<span className="mt-0.5 shrink-0 text-[9px] text-[var(--inno-text-subtle)]">
						{template.source === "custom" ? t("notes.templates.custom", "自定义") : t("notes.templates.builtIn", "内置")}
					</span>
				</button>
			))}
		</div>
	) : null;

	return (
		<div ref={rootRef} className="relative flex min-w-0">
			<button type="button" className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-md border border-[var(--inno-border)] px-2.5 text-xs font-medium hover:bg-[var(--inno-surface-muted)] disabled:opacity-50" disabled={isCreating} onClick={onCreateBlank}>
				{isCreating ? <LoaderCircle size={13} className="animate-spin" /> : <Plus size={13} />}
				<span className="truncate">{t("notes.actions.createDraft")}</span>
			</button>
			<button type="button" className="inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-r-md border border-l-0 border-[var(--inno-border)] hover:bg-[var(--inno-surface-muted)] disabled:opacity-50" disabled={isCreating} onClick={() => setOpen((value) => !value)} title={t("notes.actions.templates")} aria-expanded={open} aria-haspopup="menu">
				<ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
			</button>
			{open && menuPosition ? createPortal(
				<div
					ref={menuRef}
					className="inno-workspace-scope fixed z-[2200] w-[272px] overflow-y-auto rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] py-1 shadow-xl"
					style={menuPosition}
				>
					<div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-[var(--inno-text)]"><FilePlus2 size={14} />{t("notes.actions.templates", "从模板创建")}</div>
					{state.isLoading ? <div className="flex items-center gap-2 px-3 py-4 text-xs text-[var(--inno-text-muted)]"><LoaderCircle size={13} className="animate-spin" />{t("common.loading")}</div> : null}
					{renderGroup(t("notes.templates.mine", "我的模板"), custom)}
					{renderGroup(t("notes.templates.system", "内置模板"), system)}
					<div className="mt-1 border-t border-[var(--inno-border)] p-1">
						<button type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[var(--inno-text)] hover:bg-[var(--inno-surface-muted)]" onClick={() => { setOpen(false); onCreateTemplate(); }}><Plus size={14} />{t("notes.templates.create", "新建自定义模板")}</button>
						<button type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[var(--inno-text)] hover:bg-[var(--inno-surface-muted)]" onClick={() => { setOpen(false); onManageTemplates(); }}><Settings2 size={14} />{t("notes.templates.manage", "管理模板")}</button>
					</div>
				</div>,
				document.body,
			) : null}
		</div>
	);
}
