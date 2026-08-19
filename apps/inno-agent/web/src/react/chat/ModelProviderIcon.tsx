import { findPreset } from "../settings/provider-presets.js";

/** Brand asset when one exists; otherwise a recognizable custom AI mark. */
export function ModelProviderIcon({ provider, size = 16 }: { provider: string; size?: number }) {
	const preset = findPreset(provider);
	if (preset?.iconSrc) {
		return <img src={preset.iconSrc} alt="" aria-hidden="true" className="shrink-0 rounded object-contain" style={{ width: size, height: size }} />;
	}
	if (preset) return null;
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 18 18"
			fill="none"
			aria-hidden="true"
			className="shrink-0"
		>
			<path d="M9 2.1v1.8" stroke="var(--inno-accent)" strokeWidth="1.15" strokeLinecap="round" />
			<circle cx="9" cy="1.8" r="1.05" fill="var(--inno-accent)" />
			<rect x="2" y="4" width="14" height="11.5" rx="3.5" fill="var(--inno-accent)" />
			<path d="M2 8.5H.9M16 8.5h1.1" stroke="var(--inno-accent)" strokeWidth="1.15" strokeLinecap="round" />
			<circle cx="6.3" cy="9.2" r="1.05" fill="white" />
			<circle cx="11.7" cy="9.2" r="1.05" fill="white" />
			<path d="M6.2 12.2h5.6" stroke="white" strokeWidth="1.25" strokeLinecap="round" />
		</svg>
	);
}
