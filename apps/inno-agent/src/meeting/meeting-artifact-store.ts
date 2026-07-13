import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { extname, join } from "node:path";
import type { MeetingState, TranscriptSegment } from "./types.js";

export interface MeetingMetadata {
	id: string;
	title: string;
	rawPath: string;
	state: MeetingState;
	startedAt: number;
	updatedAt: number;
	audioPath?: string;
	error?: string;
}

export type MeetingImportJobStatus = "queued" | "converting" | "transcribing" | "summarizing" | "completed" | "failed";

export interface MeetingImportJob {
	id: string;
	meetingId: string;
	fileName: string;
	status: MeetingImportJobStatus;
	progress: number;
	createdAt: number;
	updatedAt: number;
	error?: string;
	inputFile: string;
	needsConversion: boolean;
}

function wavHeader(dataSize: number, sampleRate = 16000): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataSize, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataSize, 40);
	return header;
}

export class MeetingArtifactStore {
	constructor(private readonly rootDir: string) {
		mkdirSync(rootDir, { recursive: true });
	}

	create(metadata: Omit<MeetingMetadata, "updatedAt" | "audioPath">, saveAudio: boolean): MeetingMetadata {
		const dir = this.dir(metadata.id);
		mkdirSync(dir, { recursive: true });
		const next: MeetingMetadata = {
			...metadata,
			updatedAt: Date.now(),
			...(saveAudio ? { audioPath: join("meetings", metadata.id, "audio.wav").replaceAll("\\", "/") } : {}),
		};
		if (saveAudio) writeFileSync(join(dir, "audio.wav"), Buffer.alloc(44));
		writeFileSync(join(dir, "transcript.jsonl"), "", "utf8");
		this.writeMetadata(next);
		return next;
	}

	appendAudio(id: string, chunk: Buffer): void {
		const path = join(this.dir(id), "audio.wav");
		if (existsSync(path)) appendFileSync(path, chunk);
	}

	appendSegment(id: string, segment: TranscriptSegment): void {
		appendFileSync(join(this.dir(id), "transcript.jsonl"), `${JSON.stringify(segment)}\n`, "utf8");
	}

	update(id: string, patch: Partial<MeetingMetadata>): MeetingMetadata | null {
		const current = this.get(id);
		if (!current) return null;
		const next = { ...current, ...patch, id: current.id, updatedAt: Date.now() };
		this.writeMetadata(next);
		return next;
	}

	get(id: string): MeetingMetadata | null {
		try { return JSON.parse(readFileSync(join(this.dir(id), "metadata.json"), "utf8")) as MeetingMetadata; }
		catch { return null; }
	}

	listActive(): MeetingMetadata[] {
		if (!existsSync(this.rootDir)) return [];
		return readdirSync(this.rootDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => this.get(entry.name))
			.filter((item): item is MeetingMetadata => Boolean(item))
			.filter((item) => ["connecting", "recording", "paused", "finishing", "summarizing"].includes(item.state))
			.sort((a, b) => b.startedAt - a.startedAt);
	}

	readSegments(id: string): TranscriptSegment[] {
		try {
			return readFileSync(join(this.dir(id), "transcript.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as TranscriptSegment);
		} catch { return []; }
	}

	writeImportFile(id: string, fileName: string, data: Buffer): string {
		const extension = extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
		const path = join(this.dir(id), `imported${extension}`);
		writeFileSync(path, data);
		return path;
	}

	audioFile(id: string): string { return join(this.dir(id), "audio.wav"); }

	versionAndClearSegments(id: string): void {
		const current = join(this.dir(id), "transcript.jsonl");
		if (existsSync(current) && statSync(current).size > 0) {
			let version = 1;
			while (existsSync(join(this.dir(id), `transcript-v${version}.jsonl`))) version += 1;
			copyFileSync(current, join(this.dir(id), `transcript-v${version}.jsonl`));
		}
		writeFileSync(current, "", "utf8");
	}

	createJob(meetingId: string, fileName: string, inputFile: string, needsConversion: boolean): MeetingImportJob {
		const job: MeetingImportJob = {
			id: `import_${meetingId}_${Date.now()}`,
			meetingId,
			fileName,
			status: "queued",
			progress: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			inputFile,
			needsConversion,
		};
		this.writeJob(job);
		return job;
	}

	updateJob(id: string, patch: Partial<MeetingImportJob>): MeetingImportJob | null {
		const current = this.getJob(id);
		if (!current) return null;
		const next = { ...current, ...patch, id: current.id, meetingId: current.meetingId, updatedAt: Date.now() };
		this.writeJob(next);
		return next;
	}

	getJob(id: string): MeetingImportJob | null {
		if (!/^import_[a-zA-Z0-9_-]+$/.test(id)) return null;
		if (!existsSync(this.rootDir)) return null;
		for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const jobPath = join(this.rootDir, entry.name, "jobs", `${id}.json`);
			try { return JSON.parse(readFileSync(jobPath, "utf8")) as MeetingImportJob; }
			catch { /* continue searching */ }
		}
		return null;
	}

	listPendingJobs(): MeetingImportJob[] {
		if (!existsSync(this.rootDir)) return [];
		const jobs: MeetingImportJob[] = [];
		for (const meeting of readdirSync(this.rootDir, { withFileTypes: true })) {
			if (!meeting.isDirectory()) continue;
			const jobsDir = join(this.rootDir, meeting.name, "jobs");
			if (!existsSync(jobsDir)) continue;
			for (const file of readdirSync(jobsDir)) {
				if (!file.endsWith(".json")) continue;
				try {
					const job = JSON.parse(readFileSync(join(jobsDir, file), "utf8")) as MeetingImportJob;
					if (!["completed", "failed"].includes(job.status)) jobs.push(job);
				} catch { /* ignore malformed jobs */ }
			}
		}
		return jobs.sort((a, b) => a.createdAt - b.createdAt);
	}

	resolveJobInput(job: MeetingImportJob): string { return join(this.dir(job.meetingId), job.inputFile); }

	finalizeAudio(id: string): void {
		const path = join(this.dir(id), "audio.wav");
		if (!existsSync(path)) return;
		const size = Math.max(0, statSync(path).size - 44);
		const fd = openSync(path, "r+");
		try { writeSync(fd, wavHeader(size), 0, 44, 0); } finally { closeSync(fd); }
	}

	private dir(id: string): string { return join(this.rootDir, id); }
	private writeMetadata(metadata: MeetingMetadata): void {
		writeFileSync(join(this.dir(metadata.id), "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
	}
	private writeJob(job: MeetingImportJob): void {
		const dir = join(this.dir(job.meetingId), "jobs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, "utf8");
	}
}
