export interface SkillInfo {
	name: string;
	description: string;
	enabled: boolean;
	loaded: boolean;
	filePath: string;
	size: number;
	updatedAt: string;
	diagnostics: string[];
	category?: string;
}

export interface SkillLibraryItem {
	name: string;
	description: string;
	installed: boolean;
	category?: string;
}

export interface LocalizedSkillText {
	zh: string;
	en: string;
}

export interface SkillDisplayCopy {
	displayName: LocalizedSkillText;
	description: LocalizedSkillText;
}

export type SkillDisplayCopies = Record<string, SkillDisplayCopy>;
