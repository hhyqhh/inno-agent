export const MAX_EVIDENCE_MARKER = 999;

function outsideCodeParts(text: string): string[] {
	return text.split(/(```[\s\S]*?```|`[^`\r\n]*`)/gu);
}

export function extractEvidenceMarkers(body: string): { markers: number[]; invalid: boolean } {
	const markers: number[] = [];
	let invalid = false;
	const markerPattern = /(?:^|[^\w\\!^])\[(\d+)\](?!\s*(?:\(|\[|:))/gu;
	const parts = outsideCodeParts(body);
	for (let index = 0; index < parts.length; index += 2) {
		for (const match of parts[index].matchAll(markerPattern)) {
			const digits = match[1];
			if (digits.length > 3) {
				invalid = true;
				continue;
			}
			const marker = Number(digits);
			if (!Number.isSafeInteger(marker) || marker < 1 || marker > MAX_EVIDENCE_MARKER) {
				invalid = true;
				continue;
			}
			markers.push(marker);
		}
	}
	return { markers, invalid };
}

export function evidenceMarkersMatch(body: string, expectedMarkers: readonly number[]): boolean {
	const extracted = extractEvidenceMarkers(body);
	if (extracted.invalid) return false;
	if (extracted.markers.length === 0) return expectedMarkers.length === 0;
	const uniqueBody = new Set(extracted.markers);
	if (uniqueBody.size !== extracted.markers.length) return false;
	const orderedBody = [...uniqueBody].sort((left, right) => left - right);
	if (orderedBody.some((marker, index) => marker !== index + 1)) return false;
	if (expectedMarkers.some((marker) => !Number.isSafeInteger(marker) || marker < 1 || marker > MAX_EVIDENCE_MARKER)) {
		return false;
	}
	const uniqueExpected = new Set(expectedMarkers);
	if (uniqueExpected.size !== expectedMarkers.length || uniqueExpected.size !== orderedBody.length) return false;
	return orderedBody.every((marker) => uniqueExpected.has(marker));
}

export function stripEvidenceMarkers(text: string): string {
	const parts = outsideCodeParts(text);
	return parts.map((part, index) => {
		if (index % 2 === 1) return part;
		return part.replace(/(^|[^\w\\!^])\[\d+\](?!\s*(?:\(|\[|:))/gu, "$1");
	}).join("");
}
