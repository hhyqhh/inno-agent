import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import {
	createL2NoteDraft,
	deleteL2NoteDraft,
	listL2NoteDrafts,
	NoteDraftNotFoundError,
	NoteDraftPathError,
	readL2NoteDraft,
	saveL2NoteDraft,
} from "../../memory/l2/notes-service.js";
import { HttpError, json, readBody } from "../http-helpers.js";

export interface NotesRouteContext {
	l2DataDir: string;
}

function bodyRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new HttpError(400, "Request body must be a JSON object");
	}
	return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string") throw new HttpError(400, `Missing or invalid ${key}`);
	return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new HttpError(400, `Invalid ${key}`);
	return value;
}

function mapDraftError(error: unknown): never {
	if (error instanceof NoteDraftPathError) throw new HttpError(400, error.message);
	if (error instanceof NoteDraftNotFoundError) throw new HttpError(404, error.message);
	throw error;
}

/** Handle the draft-only portion of the notebook API. */
export async function handleNotesRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: NotesRouteContext,
): Promise<boolean> {
	const parsedUrl = new URL(url, "http://localhost");
	if (parsedUrl.pathname === "/api/l2/notes" && method === "GET") {
		json(res, 200, { notes: listL2NoteDrafts(ctx.l2DataDir) });
		return true;
	}

	if (parsedUrl.pathname === "/api/l2/notes/content" && method === "GET") {
		const rawPath = parsedUrl.searchParams.get("path");
		if (!rawPath) throw new HttpError(400, "Missing path parameter");
		try {
			json(res, 200, readL2NoteDraft(ctx.l2DataDir, rawPath));
		} catch (error) {
			mapDraftError(error);
		}
		return true;
	}

	if (parsedUrl.pathname === "/api/l2/notes" && method === "POST") {
		const body = bodyRecord(await readBody(req));
		const title = optionalString(body, "title");
		const content = optionalString(body, "content");
		json(res, 201, createL2NoteDraft(ctx.l2DataDir, { title, content }));
		return true;
	}

	if (parsedUrl.pathname === "/api/l2/notes/content" && method === "PUT") {
		const body = bodyRecord(await readBody(req));
		try {
			json(res, 200, saveL2NoteDraft(
				ctx.l2DataDir,
				requiredString(body, "rawPath"),
				{ title: requiredString(body, "title"), content: requiredString(body, "content") },
			));
		} catch (error) {
			mapDraftError(error);
		}
		return true;
	}

	if (parsedUrl.pathname === "/api/l2/notes" && method === "DELETE") {
		const rawPath = parsedUrl.searchParams.get("path");
		if (!rawPath) throw new HttpError(400, "Missing path parameter");
		try {
			json(res, 200, deleteL2NoteDraft(ctx.l2DataDir, rawPath));
		} catch (error) {
			mapDraftError(error);
		}
		return true;
	}

	return false;
}
