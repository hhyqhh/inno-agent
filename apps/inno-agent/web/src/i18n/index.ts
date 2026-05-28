import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

const STORAGE_KEY = "inno.locale";

function getInitialLocale(): string {
	if (typeof window === "undefined") return "zh-CN";
	const saved = window.localStorage.getItem(STORAGE_KEY);
	if (saved === "zh-CN" || saved === "en") return saved;
	return "zh-CN";
}

void i18n.use(initReactI18next).init({
	resources: {
		"zh-CN": { translation: zhCN },
		en: { translation: en },
	},
	lng: getInitialLocale(),
	fallbackLng: "zh-CN",
	interpolation: { escapeValue: false },
	returnNull: false,
});

export function setLocale(lng: "zh-CN" | "en"): void {
	void i18n.changeLanguage(lng);
	if (typeof window !== "undefined") {
		window.localStorage.setItem(STORAGE_KEY, lng);
	}
}

export function currentLocale(): string {
	return i18n.language || "zh-CN";
}

export default i18n;
