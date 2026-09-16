const REQUIRED = [
	"CSC_LINK",
	"CSC_KEY_PASSWORD",
	"APPLE_ID",
	"APPLE_APP_SPECIFIC_PASSWORD",
	"APPLE_TEAM_ID",
];

function validateSigningEnvironment(env) {
	const missing = REQUIRED.filter((name) => !env[name]?.trim());
	if (missing.length) {
		throw new Error(`缺少签名/公证环境变量：${missing.join(", ")}。请参阅 docs/mac-app-packaging.md。`);
	}
	if (env.APPLE_TEAM_ID !== "Q5N3RF9WVC") {
		throw new Error("APPLE_TEAM_ID 必须与项目签名证书的 Team ID Q5N3RF9WVC 一致。");
	}
	if (env.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
		throw new Error("签名发布不能设置 CSC_IDENTITY_AUTO_DISCOVERY=false。");
	}
}

module.exports = { validateSigningEnvironment };
if (require.main === module) {
	try {
		validateSigningEnvironment(process.env);
		console.log("签名/公证环境变量已齐备（尚未验证密码或 Apple 服务）。");
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
