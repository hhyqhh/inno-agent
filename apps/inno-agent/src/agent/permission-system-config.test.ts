import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildPermissionPolicy,
	ensurePermissionSystemConfig,
	PERMISSION_SYSTEM_CONFIG_RELATIVE_PATH,
	writePermissionPolicyConfig,
} from "./permission-system-config.js";

describe("permission-system-config", () => {
	let configDir: string;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "inno-perm-cfg-"));
	});

	afterEach(() => {
		rmSync(configDir, { recursive: true, force: true });
	});

	describe("buildPermissionPolicy", () => {
		it("default mode asks on unlisted bash and keeps the deny floor", () => {
			const policy = buildPermissionPolicy("default");
			expect(policy.yoloMode).toBe(false);
			expect(policy.permission.bash["*"]).toBe("ask");
			expect(policy.permission.bash["sudo *"]).toBe("deny");
			expect(policy.permission.path["~/.ssh/*"]).toBe("deny");
		});

		it("auto mode auto-approves bash but keeps the deny floor", () => {
			const policy = buildPermissionPolicy("auto");
			expect(policy.yoloMode).toBe(false);
			expect(policy.permission.bash["*"]).toBe("allow");
			expect(policy.permission.bash["sudo *"]).toBe("deny");
			expect(policy.permission.path["~/.ssh/*"]).toBe("deny");
			expect(policy.permission.path["*.pem"]).toBe("deny");
		});

		it("yolo mode enables yoloMode without touching deny rules", () => {
			const policy = buildPermissionPolicy("yolo");
			expect(policy.yoloMode).toBe(true);
			expect(policy.permission.bash["*"]).toBe("ask");
			expect(policy.permission.bash["rm -rf ~/*"]).toMatchObject({ action: "deny" });
			expect(policy.permission.path["*.key"]).toBe("deny");
		});

		it("never mutates the shared default template", () => {
			buildPermissionPolicy("auto");
			buildPermissionPolicy("yolo");
			const fresh = buildPermissionPolicy("default");
			expect(fresh.yoloMode).toBe(false);
			expect(fresh.permission.bash["*"]).toBe("ask");
		});
	});

	describe("ensurePermissionSystemConfig", () => {
		it("writes the default policy when the file is absent", () => {
			ensurePermissionSystemConfig(configDir);
			const written = JSON.parse(readFileSync(join(configDir, PERMISSION_SYSTEM_CONFIG_RELATIVE_PATH), "utf-8"));
			expect(written.yoloMode).toBe(false);
			expect(written.permission.bash["*"]).toBe("ask");
		});

		it("never overwrites an existing file", () => {
			const configPath = join(configDir, PERMISSION_SYSTEM_CONFIG_RELATIVE_PATH);
			writePermissionPolicyConfig(configDir, "yolo");
			const before = readFileSync(configPath, "utf-8");
			ensurePermissionSystemConfig(configDir);
			expect(readFileSync(configPath, "utf-8")).toBe(before);
		});
	});

	describe("writePermissionPolicyConfig", () => {
		it("overwrites the file with the policy for the requested mode", () => {
			writePermissionPolicyConfig(configDir, "default");
			writePermissionPolicyConfig(configDir, "yolo");
			const written = JSON.parse(readFileSync(join(configDir, PERMISSION_SYSTEM_CONFIG_RELATIVE_PATH), "utf-8"));
			expect(written.yoloMode).toBe(true);
		});

		it("clobbers hand edits on an explicit mode switch", () => {
			writePermissionPolicyConfig(configDir, "default");
			const configPath = join(configDir, PERMISSION_SYSTEM_CONFIG_RELATIVE_PATH);
			const edited = JSON.parse(readFileSync(configPath, "utf-8"));
			edited.permission.bash["npm *"] = "allow";
			writeFileSync(configPath, JSON.stringify(edited), "utf-8");
			writePermissionPolicyConfig(configDir, "auto");
			const written = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(written.permission.bash["npm *"]).toBeUndefined();
			expect(written.permission.bash["*"]).toBe("allow");
		});
	});
});
