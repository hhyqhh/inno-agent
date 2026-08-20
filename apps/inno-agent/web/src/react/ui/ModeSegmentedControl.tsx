import { SlidersHorizontal, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ModeSegmentedControlProps {
	simpleMode: boolean;
	togglingMode: boolean;
	onToggleMode: () => void;
	className?: string;
}

export function ModeSegmentedControl({
	simpleMode,
	togglingMode,
	onToggleMode,
	className = "",
}: ModeSegmentedControlProps) {
	const { t } = useTranslation();

	const selectMode = (nextSimpleMode: boolean) => {
		if (togglingMode || nextSimpleMode === simpleMode) return;
		onToggleMode();
	};

	return (
		<div
			className={`inno-mode-segmented-control ${className}`.trim()}
			role="group"
			aria-label={t("mode.selectorLabel")}
		>
			<button
				type="button"
				onClick={() => selectMode(true)}
				disabled={togglingMode}
				aria-pressed={simpleMode}
				title={simpleMode ? t("mode.currentSimpleClickNormal") : t("mode.switchToSimple")}
				className={`inno-mode-segmented-control__option ${simpleMode ? "is-active" : ""}`.trim()}
			>
				<WandSparkles size={14} strokeWidth={1.8} aria-hidden="true" />
				<span>{t("mode.simpleLabel")}</span>
			</button>
			<button
				type="button"
				onClick={() => selectMode(false)}
				disabled={togglingMode}
				aria-pressed={!simpleMode}
				title={!simpleMode ? t("mode.currentNormalClickSimple") : t("mode.switchToNormal")}
				className={`inno-mode-segmented-control__option ${!simpleMode ? "is-active" : ""}`.trim()}
			>
				<SlidersHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
				<span>{t("mode.normalLabel")}</span>
			</button>
		</div>
	);
}
