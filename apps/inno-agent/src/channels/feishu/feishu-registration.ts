/**
 * Feishu device-flow app registration.
 *
 * Uses the accounts.feishu.cn endpoint to provision a "PersonalAgent"
 * self-built app by having the user scan a QR code with the Feishu mobile app.
 * Same flow as larksuite/cli.
 */

import { logger } from "../../logger.js";

const FEISHU_ACCOUNTS_URL =
  "https://accounts.feishu.cn/oauth/v1/app/registration";

export interface FeishuRegistrationBeginResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string; // URL to encode as QR
  expiresIn: number; // seconds until QR expires
  interval: number; // recommended poll interval (seconds)
}

export interface FeishuRegistrationPollResult {
  status: "pending" | "confirmed" | "expired" | "denied" | "slow_down";
  appId?: string;
  appSecret?: string;
  openId?: string;
}

/**
 * Step 1: Begin the device-flow registration.
 * Returns a verification URI that should be rendered as a QR code.
 */
export async function feishuRegistrationBegin(): Promise<FeishuRegistrationBeginResult> {
  const body = new URLSearchParams({
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });

  const resp = await fetch(FEISHU_ACCOUNTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error(
      { status: resp.status, body: text },
      "[feishu-reg] begin request failed"
    );
    throw new Error(
      `Feishu registration begin failed: ${resp.status} ${text}`
    );
  }

  const data = (await resp.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri_complete?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
  };

  if (!data.device_code) {
    throw new Error("Feishu registration begin: missing device_code in response");
  }

  const verificationUri =
    data.verification_uri_complete || data.verification_uri || "";

  logger.info(
    { userCode: data.user_code, expiresIn: data.expires_in },
    "[feishu-reg] begin success"
  );

  return {
    deviceCode: data.device_code,
    userCode: data.user_code || "",
    verificationUri,
    expiresIn: data.expires_in || 600,
    interval: data.interval || 5,
  };
}

/**
 * Step 2: Poll the registration status.
 * Call this every `interval` seconds until status is no longer "pending".
 */
export async function feishuRegistrationPoll(
  deviceCode: string
): Promise<FeishuRegistrationPollResult> {
  const body = new URLSearchParams({
    action: "poll",
    device_code: deviceCode,
  });

  const resp = await fetch(FEISHU_ACCOUNTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.warn(
      { status: resp.status, body: text },
      "[feishu-reg] poll request failed"
    );
    throw new Error(`Feishu registration poll failed: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    error?: string;
    client_id?: string;
    client_secret?: string;
    user_info?: { open_id?: string; tenant_brand?: string };
  };

  // Error states
  if (data.error) {
    switch (data.error) {
      case "authorization_pending":
        return { status: "pending" };
      case "expired_token":
        return { status: "expired" };
      case "access_denied":
        return { status: "denied" };
      case "slow_down":
        return { status: "slow_down" };
      default:
        logger.warn({ error: data.error }, "[feishu-reg] unknown poll error");
        return { status: "pending" };
    }
  }

  // Success — credentials returned
  if (data.client_id && data.client_secret) {
    logger.info(
      { appId: data.client_id, openId: data.user_info?.open_id },
      "[feishu-reg] registration confirmed"
    );
    return {
      status: "confirmed",
      appId: data.client_id,
      appSecret: data.client_secret,
      openId: data.user_info?.open_id,
    };
  }

  // Unexpected shape — treat as pending
  return { status: "pending" };
}
