export class RawArchiveError extends Error {
	constructor(
		message: string,
		public code:
			| "NOT_FOUND"
			| "ALREADY_ARCHIVED"
			| "UNSUPPORTED"
			| "PARSE_ERROR"
			| "DUPLICATE"
			| "EMPTY"
			| "NOT_ARCHIVED",
	) {
		super(message);
		this.name = "RawArchiveError";
	}
}
