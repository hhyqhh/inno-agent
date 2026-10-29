import { useTranslation } from "react-i18next";
import type { InnoThinkingLevel } from "../../types/settings.js";

const levels: InnoThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function ThinkingLevelField({ enabled, value, onChange }: {
	enabled: boolean; value?: InnoThinkingLevel; onChange: (level?: InnoThinkingLevel) => void;
}) {
	const { t } = useTranslation();
	return <div className="grid gap-1 text-xs text-[var(--inno-text-muted)]">
		<label className="grid gap-1">
			{t("settings.thinking.level")}
			<select aria-label={t("settings.thinking.level")} disabled={!enabled} value={value ?? "default"} onChange={e => onChange(e.target.value === "default" ? undefined : e.target.value as InnoThinkingLevel)} className="rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-1.5 text-[var(--inno-text)] disabled:opacity-50">
				<option value="default">{t("settings.thinking.default")}</option>
				{levels.map(level => <option key={level} value={level}>{t(`settings.thinking.levels.${level}`)} ({level})</option>)}
			</select>
		</label>
		<p>{t("settings.thinking.hint")}</p>
	</div>;
}
