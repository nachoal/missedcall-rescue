import { createHash } from "node:crypto";
import type { CallState } from "../types/domain.js";

type Env = NodeJS.ProcessEnv;

export type SmsServiceOptions = {
  env?: Env;
  fetch?: typeof fetch;
};

export type SmsResult = {
  provider: "mock" | "twilio";
  callId: string;
  messageId: string;
  to: string;
  body: string;
  status: string;
  raw: Record<string, unknown>;
};

export async function sendDepositLink(
  callState: CallState,
  depositUrl = callState.depositCheckoutUrl,
  options: SmsServiceOptions = {},
): Promise<SmsResult> {
  if (!depositUrl) {
    throw new Error("sendDepositLink requires a deposit checkout URL.");
  }

  const body = buildDepositMessage(depositUrl);
  if (!shouldUseTwilio(options.env ?? process.env)) {
    const messageId = mockTwilioMessageId(callState.callId, callState.callerPhone, depositUrl);
    return {
      provider: "mock",
      callId: callState.callId,
      messageId,
      to: callState.callerPhone,
      body,
      status: "queued",
      raw: {
        sid: messageId,
        status: "queued",
        to: callState.callerPhone,
        body,
      },
    };
  }

  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const params = new URLSearchParams({
    To: callState.callerPhone,
    From: env.TWILIO_FROM_NUMBER as string,
    Body: body,
  });

  const response = await fetchImpl(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    },
  );
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    throw new Error(`Twilio message failed with ${response.status}: ${safeErrorPayload(payload)}`);
  }

  return {
    provider: "twilio",
    callId: callState.callId,
    messageId: stringValue(payload.sid) ?? "",
    to: stringValue(payload.to) ?? callState.callerPhone,
    body: stringValue(payload.body) ?? body,
    status: stringValue(payload.status) ?? "queued",
    raw: {
      sid: payload.sid,
      status: payload.status,
      to: payload.to,
      from: payload.from,
      error_code: payload.error_code,
      uri: payload.uri,
    },
  };
}

export function shouldUseTwilio(env: Env = process.env): boolean {
  return (
    env.USE_MOCKS === "false" &&
    Boolean(env.TWILIO_ACCOUNT_SID?.trim() && env.TWILIO_AUTH_TOKEN?.trim() && env.TWILIO_FROM_NUMBER?.trim())
  );
}

function buildDepositMessage(depositUrl: string): string {
  return `MissedCall Rescue: your emergency AC diagnostic deposit link is ${depositUrl}`;
}

function mockTwilioMessageId(callId: string, to: string, depositUrl: string): string {
  return `SM${shortHash(callId, to, depositUrl).slice(0, 32)}`;
}

function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

function safeErrorPayload(payload: Record<string, unknown>): string {
  return JSON.stringify({
    code: payload.code,
    message: payload.message,
    more_info: payload.more_info,
    status: payload.status,
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
