import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { publishDemoLedgerEvent } from "./demo-events.js";
import type { LedgerEvent, LedgerVerification } from "./types/domain.js";

const ZERO_HASH = "0".repeat(64);

export type LedgerAppendInput = {
  callId: string;
  type: string;
  amount?: number;
  currency?: LedgerEvent["currency"];
  stripe_id?: string;
  policy_decision?: LedgerEvent["policy_decision"];
  payload?: Record<string, unknown>;
  ts?: string;
};

export type LedgerOptions = {
  ledgerPath?: string;
  callId?: string;
};

export type LedgerTarget = LedgerOptions | string;

export function defaultLedgerPath(): string {
  return resolve(process.env.LEDGER_PATH ?? "./data/events.jsonl");
}

function optionsFor(target?: LedgerTarget): LedgerOptions {
  return typeof target === "string" ? { callId: target } : (target ?? {});
}

function pathFor(target?: LedgerTarget): string {
  const options = optionsFor(target);
  return resolve(options.ledgerPath ?? defaultLedgerPath());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (value === undefined) {
    return "null";
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

function hashCanonicalPayload(payload: Omit<LedgerEvent, "hash">): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

function eventPayloadForHash(event: LedgerEvent): Omit<LedgerEvent, "hash"> {
  const { hash: _hash, ...payload } = event;
  return payload;
}

function ledgerEventFromUnknown(value: unknown): LedgerEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value.index !== "number" ||
    !Number.isInteger(value.index) ||
    typeof value.ts !== "string" ||
    typeof value.callId !== "string" ||
    typeof value.type !== "string" ||
    !isRecord(value.payload) ||
    typeof value.prev_hash !== "string" ||
    typeof value.hash !== "string"
  ) {
    return undefined;
  }

  if (value.amount !== undefined && typeof value.amount !== "number") {
    return undefined;
  }

  if (value.currency !== undefined && value.currency !== "usd") {
    return undefined;
  }

  if (value.stripe_id !== undefined && typeof value.stripe_id !== "string") {
    return undefined;
  }

  if (
    value.policy_decision !== undefined &&
    value.policy_decision !== "allow" &&
    value.policy_decision !== "deny" &&
    value.policy_decision !== "none"
  ) {
    return undefined;
  }

  return value as LedgerEvent;
}

export async function readLedger(target?: LedgerTarget): Promise<LedgerEvent[]> {
  const options = optionsFor(target);
  const ledgerPath = pathFor(options);
  let text: string;

  try {
    text = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events = lines.map((line, lineIndex) => {
    const parsed: unknown = JSON.parse(line);
    const event = ledgerEventFromUnknown(parsed);
    if (event === undefined) {
      throw new Error(`Invalid ledger event at line ${lineIndex + 1}`);
    }
    return event;
  });
  return options.callId === undefined
    ? events
    : events.filter((event) => event.callId === options.callId);
}

export async function appendLedger(
  input: LedgerAppendInput,
  target?: LedgerTarget,
): Promise<LedgerEvent> {
  const ledgerPath = pathFor(target);
  const existing = await readLedger({ ledgerPath });
  const previous = existing.at(-1);

  const unsigned: Omit<LedgerEvent, "hash"> = {
    index: existing.length,
    ts: input.ts ?? new Date().toISOString(),
    callId: input.callId,
    type: input.type,
    ...(input.amount === undefined ? {} : { amount: input.amount }),
    ...(input.currency === undefined ? {} : { currency: input.currency }),
    ...(input.stripe_id === undefined ? {} : { stripe_id: input.stripe_id }),
    ...(input.policy_decision === undefined
      ? {}
      : { policy_decision: input.policy_decision }),
    payload: input.payload ?? {},
    prev_hash: previous?.hash ?? ZERO_HASH,
  };
  const event: LedgerEvent = {
    ...unsigned,
    hash: hashCanonicalPayload(unsigned),
  };

  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(event)}\n`, "utf8");
  await publishDemoLedgerEvent(event);

  return event;
}

export async function verifyLedger(
  target?: LedgerTarget,
): Promise<LedgerVerification> {
  const options = optionsFor(target);
  const ledgerPath = pathFor(options);
  let text: string;

  try {
    text = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        valid: true,
        eventCount: 0,
        errors: [],
      };
    }
    throw error;
  }

  const errors: string[] = [];
  const allEvents: LedgerEvent[] = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

  lines.forEach((line, lineIndex) => {
    try {
      const parsed: unknown = JSON.parse(line);
      const event = ledgerEventFromUnknown(parsed);
      if (event === undefined) {
        errors.push(`line ${lineIndex + 1}: invalid ledger event shape`);
        return;
      }
      allEvents.push(event);
    } catch (error) {
      errors.push(
        `line ${lineIndex + 1}: invalid JSON (${(error as Error).message})`,
      );
    }
  });

  allEvents.forEach((event, eventIndex) => {
    const expectedIndex = eventIndex;
    const expectedPrevHash =
      eventIndex === 0 ? ZERO_HASH : allEvents[eventIndex - 1]?.hash;
    const expectedHash = hashCanonicalPayload(eventPayloadForHash(event));

    if (event.index !== expectedIndex) {
      errors.push(
        `line ${eventIndex + 1}: expected index ${expectedIndex}, got ${event.index}`,
      );
    }

    if (event.prev_hash !== expectedPrevHash) {
      errors.push(`line ${eventIndex + 1}: prev_hash does not match previous hash`);
    }

    if (event.hash !== expectedHash) {
      errors.push(`line ${eventIndex + 1}: hash does not match canonical payload`);
    }
  });

  const events =
    options.callId === undefined
      ? allEvents
      : allEvents.filter((event) => event.callId === options.callId);

  return {
    valid: errors.length === 0,
    eventCount: events.length,
    firstHash: events[0]?.hash,
    lastHash: events.at(-1)?.hash,
    errors,
  };
}

export async function resetLedgerForDemo(target?: LedgerTarget): Promise<void> {
  const ledgerPath = pathFor(target);
  const projectRoot = resolve(".");

  if (!ledgerPath.startsWith(`${projectRoot}/`)) {
    throw new Error(`Refusing to reset ledger outside project: ${ledgerPath}`);
  }

  await mkdir(dirname(ledgerPath), { recursive: true });
  await rm(ledgerPath, { force: true });
}
