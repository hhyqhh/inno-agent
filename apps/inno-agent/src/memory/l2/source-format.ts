import { readFileSync } from "node:fs";
import { extname } from "node:path";

export type ArchivableFileType = "pdf" | "word" | "markdown";

export type SourceFormatErrorCode =
	| "SOURCE_READ_FAILED"
	| "INVALID_EXTENSION"
	| "INVALID_PDF_SIGNATURE"
	| "INVALID_DOCX_ARCHIVE"
	| "MISSING_DOCX_DOCUMENT"
	| "INVALID_UTF8";

export class SourceFormatError extends Error {
	constructor(
		public readonly code: SourceFormatErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SourceFormatError";
	}
}

export interface ValidatedSourceFormat {
	extension: ".pdf" | ".docx" | ".md" | ".markdown";
	mimeType: string;
}

const EXPECTED_EXTENSIONS: Record<ArchivableFileType, readonly string[]> = {
	pdf: [".pdf"],
	word: [".docx"],
	markdown: [".md", ".markdown"],
};

function validateExtension(extension: string, sourceType: ArchivableFileType): void {
	if (!EXPECTED_EXTENSIONS[sourceType].includes(extension)) {
		throw new SourceFormatError("INVALID_EXTENSION", "The file extension does not match the declared source type.");
	}
}

function invalidDocx(): never {
	throw new SourceFormatError("INVALID_DOCX_ARCHIVE", "The DOCX ZIP structure is invalid.");
}

function hasDocxDocumentEntry(bytes: Buffer): boolean {
	if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) invalidDocx();

	const minimumEndOffset = Math.max(0, bytes.length - 22 - 0xffff);
	let endOffset = -1;
	for (let offset = bytes.length - 22; offset >= minimumEndOffset; offset -= 1) {
		if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
		const commentLength = bytes.readUInt16LE(offset + 20);
		if (offset + 22 + commentLength === bytes.length) {
			endOffset = offset;
			break;
		}
	}
	if (endOffset < 0) invalidDocx();

	const diskNumber = bytes.readUInt16LE(endOffset + 4);
	const centralDiskNumber = bytes.readUInt16LE(endOffset + 6);
	const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
	const totalEntries = bytes.readUInt16LE(endOffset + 10);
	const centralSize = bytes.readUInt32LE(endOffset + 12);
	const centralOffset = bytes.readUInt32LE(endOffset + 16);
	if (
		diskNumber !== 0
		|| centralDiskNumber !== 0
		|| entriesOnDisk !== totalEntries
		|| totalEntries === 0xffff
		|| centralSize === 0xffffffff
		|| centralOffset === 0xffffffff
		|| centralOffset + centralSize > endOffset
	) {
		invalidDocx();
	}

	const centralEnd = centralOffset + centralSize;
	let cursor = centralOffset;
	let foundDocument = false;
	for (let index = 0; index < totalEntries; index += 1) {
		if (cursor + 46 > centralEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) invalidDocx();
		const flags = bytes.readUInt16LE(cursor + 8);
		const compressionMethod = bytes.readUInt16LE(cursor + 10);
		const crc32 = bytes.readUInt32LE(cursor + 16);
		const compressedSize = bytes.readUInt32LE(cursor + 20);
		const uncompressedSize = bytes.readUInt32LE(cursor + 24);
		const nameLength = bytes.readUInt16LE(cursor + 28);
		const extraLength = bytes.readUInt16LE(cursor + 30);
		const commentLength = bytes.readUInt16LE(cursor + 32);
		const localOffset = bytes.readUInt32LE(cursor + 42);
		const next = cursor + 46 + nameLength + extraLength + commentLength;
		if (
			next > centralEnd
			|| localOffset + 30 > centralOffset
			|| bytes.readUInt32LE(localOffset) !== 0x04034b50
		) {
			invalidDocx();
		}
		const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
		const localFlags = bytes.readUInt16LE(localOffset + 6);
		const localCompressionMethod = bytes.readUInt16LE(localOffset + 8);
		const localNameLength = bytes.readUInt16LE(localOffset + 26);
		const localExtraLength = bytes.readUInt16LE(localOffset + 28);
		const localNameStart = localOffset + 30;
		const localDataStart = localNameStart + localNameLength + localExtraLength;
		const localDataEnd = localDataStart + compressedSize;
		if (
			localDataStart > centralOffset
			|| localDataEnd > centralOffset
			|| localFlags !== flags
			|| localCompressionMethod !== compressionMethod
			|| localNameLength !== nameLength
			|| !bytes.subarray(localNameStart, localNameStart + localNameLength).equals(name)
		) {
			invalidDocx();
		}
		if (
			(flags & 0x0008) === 0
			&& (
				bytes.readUInt32LE(localOffset + 14) !== crc32
				|| bytes.readUInt32LE(localOffset + 18) !== compressedSize
				|| bytes.readUInt32LE(localOffset + 22) !== uncompressedSize
			)
		) {
			invalidDocx();
		}
		if (name.equals(Buffer.from("word/document.xml", "ascii"))) foundDocument = true;
		cursor = next;
	}
	if (cursor !== centralEnd) invalidDocx();
	return foundDocument;
}

/** @internal Validate bytes already captured from a controlled file descriptor. */
export function validateSourceBytes(
	extensionInput: string,
	bytesInput: Uint8Array,
	sourceType: ArchivableFileType,
): ValidatedSourceFormat {
	const extension = extensionInput.toLowerCase();
	validateExtension(extension, sourceType);

	const bytes = Buffer.isBuffer(bytesInput)
		? bytesInput
		: Buffer.from(bytesInput.buffer, bytesInput.byteOffset, bytesInput.byteLength);
	if (sourceType === "pdf") {
		if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) {
			throw new SourceFormatError("INVALID_PDF_SIGNATURE", "The PDF signature is invalid.");
		}
		return { extension: ".pdf", mimeType: "application/pdf" };
	}

	if (sourceType === "word") {
		if (!hasDocxDocumentEntry(bytes)) {
			throw new SourceFormatError("MISSING_DOCX_DOCUMENT", "The DOCX document part is missing.");
		}
		return {
			extension: ".docx",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		};
	}

	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new SourceFormatError("INVALID_UTF8", "The Markdown file is not valid UTF-8.");
	}
	return {
		extension: extension as ".md" | ".markdown",
		mimeType: "text/markdown; charset=utf-8",
	};
}

export function validateSourceFile(
	filePath: string,
	sourceType: ArchivableFileType,
): ValidatedSourceFormat {
	const extension = extname(filePath).toLowerCase();
	validateExtension(extension, sourceType);
	let bytes: Buffer;
	try {
		bytes = readFileSync(filePath);
	} catch {
		throw new SourceFormatError("SOURCE_READ_FAILED", "The source file could not be read.");
	}
	return validateSourceBytes(extension, bytes, sourceType);
}
