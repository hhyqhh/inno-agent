// electron-builder afterPack hook.
//
// node-pty ships its macOS/Linux `spawn-helper` binary without the executable
// bit. node-pty execs the *asar.unpacked* copy via posix_spawn, so when the bit
// is missing the terminal fails with "posix_spawnp failed.". The app bundle is
// read-only once installed, so this must be fixed at pack time, not runtime.
const { existsSync, chmodSync, statSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
	if (context.electronPlatformName === "win32") return;

	const resourcesDir =
		context.electronPlatformName === "darwin"
			? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
			: join(context.appOutDir, "resources");

	const unpacked = join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty");
	const candidates = [
		join(unpacked, "build", "Release", "spawn-helper"),
		join(unpacked, "build", "Debug", "spawn-helper"),
		join(unpacked, "prebuilds", "darwin-arm64", "spawn-helper"),
		join(unpacked, "prebuilds", "darwin-x64", "spawn-helper"),
		join(unpacked, "prebuilds", "linux-x64", "spawn-helper"),
		join(unpacked, "prebuilds", "linux-arm64", "spawn-helper"),
	];

	let fixed = 0;
	for (const helper of candidates) {
		if (!existsSync(helper)) continue;
		const mode = statSync(helper).mode;
		if ((mode & 0o111) === 0) {
			chmodSync(helper, mode | 0o755);
			console.log(`[afterPack] chmod +x ${helper}`);
			fixed++;
		}
	}
	if (fixed === 0) {
		console.log("[afterPack] spawn-helper already executable (or not found)");
	}
};
