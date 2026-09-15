import { describe, expect, it } from "vitest";
import { TOPIC_UPGRADE_MESSAGE_THRESHOLD, type SessionSummary } from "../session-model.js";
import { withRecordedTopic } from "./sessions.js";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "s1",
		name: "s1",
		createdAt: "2026-09-15T00:00:00.000Z",
		updatedAt: "2026-09-15T00:00:00.000Z",
		messageCount: 2,
		preview: "hello",
		channels: ["web"],
		...overrides,
	};
}

describe("withRecordedTopic", () => {
	it("reports no topic when nothing is recorded", () => {
		const result = withRecordedTopic(summary(), {});
		expect(result.hasTopic).toBe(false);
		expect(result.topicPendingUpgrade).toBe(false);
		expect(result.name).toBe("s1");
	});

	it("keeps a generated preview final below the upgrade threshold", () => {
		const result = withRecordedTopic(summary({ messageCount: TOPIC_UPGRADE_MESSAGE_THRESHOLD - 1 }), {
			s1: { topic: "preview title", updatedAt: "2026-09-15T00:00:00.000Z", generated: true },
		});
		expect(result.name).toBe("preview title");
		expect(result.hasTopic).toBe(true);
		expect(result.topicPendingUpgrade).toBe(false);
	});

	it("flags a generated preview as pending once the conversation reaches the threshold", () => {
		const result = withRecordedTopic(summary({ messageCount: TOPIC_UPGRADE_MESSAGE_THRESHOLD }), {
			s1: { topic: "preview title", updatedAt: "2026-09-15T00:00:00.000Z", generated: true },
		});
		expect(result.topicPendingUpgrade).toBe(true);
	});

	it("settles once the upgrade lands", () => {
		const result = withRecordedTopic(summary({ messageCount: TOPIC_UPGRADE_MESSAGE_THRESHOLD + 2 }), {
			s1: { topic: "贝叶斯定理入门", updatedAt: "2026-09-15T00:00:00.000Z", generated: true, upgraded: true },
		});
		expect(result.name).toBe("贝叶斯定理入门");
		expect(result.topicPendingUpgrade).toBe(false);
	});

	it("never flags a manual rename as pending upgrade", () => {
		const result = withRecordedTopic(summary({ messageCount: TOPIC_UPGRADE_MESSAGE_THRESHOLD + 2 }), {
			s1: { topic: "my title", updatedAt: "2026-09-15T00:00:00.000Z" },
		});
		expect(result.topicPendingUpgrade).toBe(false);
	});
});
