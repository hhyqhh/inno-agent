import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SourceFormatError, validateSourceFile } from "./source-format.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-source-format-"));
	tempDirs.push(dir);
	return dir;
}

function makeZip(entries: Array<{ name: string; data?: string }>): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let localOffset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const data = Buffer.from(entry.data ?? "", "utf8");
		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt32LE(data.length, 18);
		localHeader.writeUInt32LE(data.length, 22);
		localHeader.writeUInt16LE(name.length, 26);
		localParts.push(localHeader, name, data);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt32LE(data.length, 20);
		centralHeader.writeUInt32LE(data.length, 24);
		centralHeader.writeUInt16LE(name.length, 28);
		centralHeader.writeUInt32LE(localOffset, 42);
		centralParts.push(centralHeader, name);
		localOffset += localHeader.length + name.length + data.length;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(localOffset, 16);
	return Buffer.concat([...localParts, centralDirectory, end]);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("validateSourceFile", () => {
	it("maps source read failures to a stable path-safe error", () => {
		const filePath = join(makeTempDir(), "missing.pdf");
		let thrown: unknown;

		try {
			validateSourceFile(filePath, "pdf");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(SourceFormatError);
		expect(thrown).toMatchObject({ code: "SOURCE_READ_FAILED" });
		expect((thrown as Error).message).not.toContain(filePath);
	});

	it("rejects a .pdf file without the PDF signature using a path-safe stable error", () => {
		const filePath = join(makeTempDir(), "lesson.pdf");
		writeFileSync(filePath, "not a pdf");

		let thrown: unknown;
		try {
			validateSourceFile(filePath, "pdf");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(SourceFormatError);
		expect(thrown).toMatchObject({ code: "INVALID_PDF_SIGNATURE" });
		expect((thrown as Error).message).not.toContain(filePath);
	});

	it("accepts a PDF only when its declared type, extension, and signature agree", () => {
		const dir = makeTempDir();
		const pdfPath = join(dir, "lesson.PDF");
		writeFileSync(pdfPath, "%PDF-1.7\nbody");

		expect(validateSourceFile(pdfPath, "pdf")).toEqual({
			extension: ".pdf",
			mimeType: "application/pdf",
		});

		const mismatchedPath = join(dir, "lesson.docx");
		writeFileSync(mismatchedPath, "%PDF-1.7\nbody");
		expect(() => validateSourceFile(mismatchedPath, "pdf")).toThrowError(
			expect.objectContaining({ code: "INVALID_EXTENSION" }),
		);
	});

	it("rejects a .docx file that is not a ZIP archive", () => {
		const filePath = join(makeTempDir(), "lesson.docx");
		writeFileSync(filePath, "not a zip");

		expect(() => validateSourceFile(filePath, "word")).toThrowError(
			expect.objectContaining({ code: "INVALID_DOCX_ARCHIVE" }),
		);
	});

	it("requires word/document.xml to be a central-directory entry", () => {
		const filePath = join(makeTempDir(), "lesson.docx");
		writeFileSync(
			filePath,
			makeZip([{ name: "notes.txt", data: "misleading bytes: word/document.xml" }]),
		);

		expect(() => validateSourceFile(filePath, "word")).toThrowError(
			expect.objectContaining({ code: "MISSING_DOCX_DOCUMENT" }),
		);
	});

	it("accepts a DOCX whose central directory contains word/document.xml", () => {
		const filePath = join(makeTempDir(), "lesson.docx");
		writeFileSync(filePath, makeZip([{ name: "word/document.xml", data: "<w:document/>" }]));

		expect(validateSourceFile(filePath, "word")).toEqual({
			extension: ".docx",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		});
	});

	it("rejects a central entry whose referenced local header names a different file", () => {
		const filePath = join(makeTempDir(), "lesson.docx");
		const forged = makeZip([{ name: "word/document.xml", data: "<w:document/>" }]);
		Buffer.from("evil/document.bin", "ascii").copy(forged, 30);
		writeFileSync(filePath, forged);

		expect(() => validateSourceFile(filePath, "word")).toThrowError(
			expect.objectContaining({ code: "INVALID_DOCX_ARCHIVE" }),
		);
	});

	it("accepts UTF-8 Markdown with either supported extension", () => {
		const dir = makeTempDir();
		const shortPath = join(dir, "notes.MD");
		const longPath = join(dir, "notes.markdown");
		writeFileSync(shortPath, "# 你好 🌱\n", "utf8");
		writeFileSync(longPath, "plain text\n", "utf8");

		expect(validateSourceFile(shortPath, "markdown")).toEqual({
			extension: ".md",
			mimeType: "text/markdown; charset=utf-8",
		});
		expect(validateSourceFile(longPath, "markdown")).toEqual({
			extension: ".markdown",
			mimeType: "text/markdown; charset=utf-8",
		});
	});

	it("rejects Markdown bytes that are not strict UTF-8", () => {
		const filePath = join(makeTempDir(), "notes.md");
		writeFileSync(filePath, Buffer.from([0x23, 0x20, 0xc3, 0x28]));

		expect(() => validateSourceFile(filePath, "markdown")).toThrowError(
			expect.objectContaining({ code: "INVALID_UTF8" }),
		);
	});
});
