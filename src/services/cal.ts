import { createHash } from "node:crypto";
import type { CallState } from "../types/domain.js";

type Env = NodeJS.ProcessEnv;

export type CalServiceOptions = {
  env?: Env;
  fetch?: typeof fetch;
};

export type BookingResult = {
  provider: "mock" | "cal";
  callId: string;
  bookingId: string;
  selectedIsoStart: string;
  status: string;
  raw: Record<string, unknown>;
};

export type AvailableSlotResult = {
  provider: "mock" | "cal";
  selectedIsoStart: string;
  raw: Record<string, unknown>;
};

export async function createBooking(
  callState: CallState,
  selectedIsoStart: string,
  options: CalServiceOptions = {},
): Promise<BookingResult> {
  const start = normalizeIsoStart(selectedIsoStart);

  if (!shouldUseCal(options.env ?? process.env)) {
    const bookingId = mockCalId(callState.callId, start);
    return {
      provider: "mock",
      callId: callState.callId,
      bookingId,
      selectedIsoStart: start,
      status: "accepted",
      raw: {
        id: bookingId,
        uid: bookingId,
        status: "accepted",
        start,
        metadata: { callId: callState.callId },
      },
    };
  }

  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const eventTypeId = Number(env.CAL_EVENT_TYPE_ID);
  if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    throw new Error("CAL_EVENT_TYPE_ID must be a positive integer when Cal is configured.");
  }

  const attendeeEmail =
    callState.email ??
    env.CAL_FALLBACK_ATTENDEE_EMAIL ??
    `${safeSlug(callState.callId)}@example.com`;

  const response = await fetchImpl("https://api.cal.com/v2/bookings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CAL_API_KEY}`,
      "Content-Type": "application/json",
      "cal-api-version": env.CAL_API_VERSION ?? "2024-08-13",
    },
    body: JSON.stringify({
      start,
      attendee: {
        name: callState.customerName ?? "MissedCall Rescue caller",
        email: attendeeEmail,
        phoneNumber: callState.callerPhone,
        timeZone: env.CAL_TIMEZONE ?? "America/New_York",
      },
      eventTypeId,
      bookingFieldsResponses: {
        callId: callState.callId,
        address: callState.address ?? "",
        problem: callState.problem ?? "",
        preferredWindow: callState.preferredWindow ?? "",
        vulnerablePerson: callState.vulnerablePerson ? "yes" : "no",
      },
      metadata: {
        callId: callState.callId,
        source: "missedcall_rescue",
      },
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Cal booking failed with ${response.status}: ${safeErrorPayload(payload)}`);
  }

  return normalizeCalBooking(callState.callId, start, payload);
}

export async function findAvailableSlot(
  options: CalServiceOptions = {},
): Promise<AvailableSlotResult> {
  const env = options.env ?? process.env;
  if (!shouldUseCal(env)) {
    return {
      provider: "mock",
      selectedIsoStart: fallbackStart().toISOString(),
      raw: { source: "mock" },
    };
  }

  const eventTypeId = Number(env.CAL_EVENT_TYPE_ID);
  if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
    throw new Error("CAL_EVENT_TYPE_ID must be a positive integer when Cal is configured.");
  }

  const fetchImpl = options.fetch ?? fetch;
  const startTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const endTime = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    eventTypeId: String(eventTypeId),
    startTime,
    endTime,
    timeZone: env.CAL_TIMEZONE ?? "America/New_York",
  });

  const response = await fetchImpl(`https://api.cal.com/v2/slots/available?${params}`, {
    headers: {
      Authorization: `Bearer ${env.CAL_API_KEY}`,
      "cal-api-version": env.CAL_SLOTS_API_VERSION ?? "2024-06-14",
    },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Cal slots lookup failed with ${response.status}: ${safeErrorPayload(payload)}`);
  }

  const slot = firstSlotTime(payload);
  if (!slot) {
    throw new Error("Cal slots lookup returned no available slots for the next 14 days.");
  }

  return {
    provider: "cal",
    selectedIsoStart: new Date(slot).toISOString(),
    raw: {
      eventTypeId,
      startTime,
      endTime,
      slot,
    },
  };
}

export function shouldUseCal(env: Env = process.env): boolean {
  return env.USE_MOCKS === "false" && Boolean(env.CAL_API_KEY?.trim() && env.CAL_EVENT_TYPE_ID?.trim());
}

function normalizeCalBooking(callId: string, selectedIsoStart: string, payload: Record<string, unknown>): BookingResult {
  const data = asRecord(payload.data);
  const bookingId = stringValue(data.uid) ?? stringValue(data.id) ?? mockCalId(callId, selectedIsoStart);

  return {
    provider: "cal",
    callId,
    bookingId,
    selectedIsoStart: stringValue(data.start) ?? selectedIsoStart,
    status: stringValue(data.status) ?? stringValue(payload.status) ?? "unknown",
    raw: {
      status: stringValue(payload.status),
      data: {
        id: data.id,
        uid: data.uid,
        status: data.status,
        start: data.start,
        end: data.end,
        eventTypeId: data.eventTypeId,
        meetingUrl: data.meetingUrl,
        metadata: safeMetadata(data.metadata),
      },
    },
  };
}

function normalizeIsoStart(selectedIsoStart: string): string {
  const date = new Date(selectedIsoStart);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("selectedIsoStart must be a valid ISO date-time.");
  }
  return date.toISOString();
}

function fallbackStart(): Date {
  const now = new Date();
  const start = new Date(now);
  start.setHours(Math.max(now.getHours() + 2, 18), 0, 0, 0);
  return start;
}

function mockCalId(callId: string, selectedIsoStart: string): string {
  return `book_mock_${safeSlug(callId)}_${shortHash(callId, selectedIsoStart)}`;
}

function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 20);
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.slice(0, 24) || "call";
}

function safeMetadata(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const safe: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      safe[key] = String(item);
    }
  }
  return safe;
}

function safeErrorPayload(payload: Record<string, unknown>): string {
  return JSON.stringify({
    status: payload.status,
    error: payload.error,
    message: payload.message,
  });
}

function firstSlotTime(payload: Record<string, unknown>): string | undefined {
  const data = asRecord(payload.data);
  const slots = asRecord(data.slots);
  const dates = Object.keys(slots).sort();
  for (const date of dates) {
    const rows = Array.isArray(slots[date]) ? slots[date] : [];
    for (const row of rows) {
      const time = stringValue(asRecord(row).time);
      if (time) return time;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}
