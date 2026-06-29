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
