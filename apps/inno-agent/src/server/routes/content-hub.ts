import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import type { ContentHubStatus } from "../../content-source/types.js";
import { json } from "../http-helpers.js";

export interface ContentHubRouteContext {
	getContentHubStatus: () => Promise<ContentHubStatus>;
}

/** Lightweight remote-catalog status endpoint used by background update checks. */
export async function handleContentHubRoutes(
	_req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: ContentHubRouteContext,
): Promise<boolean> {
	if (method !== "GET" || url.split("?")[0] !== "/api/content-hub/status") return false;
	try {
		json(res, 200, await ctx.getContentHubStatus());
	} catch (err) {
		json(res, 502, { error: err instanceof Error ? err.message : "Failed to check content hub status" });
	}
	return true;
}
