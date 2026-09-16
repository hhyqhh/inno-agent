// Release-only overlay. No passwords or certificate bytes belong in this file.
const { build } = require("../package.json");

module.exports = {
	...build,
	forceCodeSigning: true,
	mac: {
		...build.mac,
		identity: "Hao Hao (Q5N3RF9WVC)",
		hardenedRuntime: true,
		notarize: true,
		artifactName: "${name}-${version}-${arch}.${ext}",
		// Keep electron-builder's Electron entitlements for the app and helpers.
	},
};
