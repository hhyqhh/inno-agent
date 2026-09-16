const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateSigningEnvironment } = require("./check-mac-signing.cjs");

const valid = {
	CSC_LINK: "dummy-certificate-not-a-secret",
	CSC_KEY_PASSWORD: "dummy-password-not-a-secret",
	APPLE_ID: "test@example.com",
	APPLE_APP_SPECIFIC_PASSWORD: "dummy-app-password-not-a-secret",
	APPLE_TEAM_ID: "Q5N3RF9WVC",
};

test("complete credentials pass the presence check", () => {
	assert.doesNotThrow(() => validateSigningEnvironment(valid));
});
for (const name of Object.keys(valid)) {
	test(`missing ${name} fails closed without disclosing values`, () => {
		assert.throws(() => validateSigningEnvironment({ ...valid, [name]: "  " }), (error) => {
			assert.ok(error.message.includes(name));
			assert.ok(!error.message.includes(valid.CSC_KEY_PASSWORD));
			assert.ok(!error.message.includes(valid.APPLE_APP_SPECIFIC_PASSWORD));
			return true;
		});
	});
}
test("another Apple team is rejected", () => {
	assert.throws(() => validateSigningEnvironment({ ...valid, APPLE_TEAM_ID: "OTHERTEAM" }), /Team ID/);
});
test("unsigned environment is rejected", () => {
	assert.throws(() => validateSigningEnvironment({ ...valid, CSC_IDENTITY_AUTO_DISCOVERY: "false" }), /AUTO_DISCOVERY/);
});
test("release overlay preserves packaging and requires Developer ID + notarization", () => {
	const signed = require("../build/electron-builder.mac-signed.cjs");
	const base = require("../package.json").build;
	assert.equal(signed.forceCodeSigning, true);
	assert.equal(signed.mac.notarize, true);
	assert.equal(signed.mac.hardenedRuntime, true);
	assert.equal(signed.mac.identity, "Hao Hao (Q5N3RF9WVC)");
	for (const key of ["appId", "afterPack", "files", "asarUnpack", "win", "linux"]) {
		assert.deepEqual(signed[key], base[key]);
	}
	assert.deepEqual(signed.mac.target, base.mac.target);
	assert.equal(base.forceCodeSigning, undefined);
});
