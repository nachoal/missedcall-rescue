import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { LedgerEvent, LedgerVerification } from "./types/domain.js";

export type DemoEvent = {
  seq: number;
  id: string;
  ts: string;
  callId: string;
  type: string;
  stage: string;
  status?: string;
  title?: string;
  summary?: string;
  payload: Record<string, unknown>;
};

export type PublishDemoEventInput = Omit<DemoEvent, "seq" | "id" | "ts" | "payload"> & {
  ts?: string;
  id?: string;
  payload?: Record<string, unknown>;
};

export type DemoEventOptions = {
  rootDir?: string;
};

type CurrentDemoRun = {
  callId: string;
  resetAt?: string;
  updatedAt?: string;
};

export function demoDataDir(rootDir = process.cwd()): string {
  return resolve(rootDir, "data", "demo");
}

export function demoEventsPath(rootDir = process.cwd()): string {
  return resolve(demoDataDir(rootDir), "events.ndjson");
}

export function demoCurrentPath(rootDir = process.cwd()): string {
  return resolve(demoDataDir(rootDir), "current.json");
}

export async function resetDemoRun(
  callId: string,
  options: DemoEventOptions = {},
): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  await mkdir(demoDataDir(rootDir), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(demoEventsPath(rootDir), "", "utf8");
  await writeCurrentDemoRun(callId, { rootDir, resetAt: now });
  await publishDemoEvent(
    {
      callId,
      type: "run.reset",
      stage: "run",
      status: "ready",
      title: "Demo console reset",
      summary: "Clean run state prepared for recording.",
      ts: now,
    },
    { rootDir },
  );
}

export async function publishDemoEvent(
  input: PublishDemoEventInput,
  options: DemoEventOptions = {},
): Promise<DemoEvent> {
  const rootDir = options.rootDir ?? process.cwd();
  await mkdir(demoDataDir(rootDir), { recursive: true });
  await writeCurrentDemoRun(input.callId, { rootDir });
  const seq = await nextDemoSeq(rootDir);
  const event: DemoEvent = {
    seq,
    id: input.id ?? randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    callId: input.callId,
    type: input.type,
    stage: input.stage,
    ...(input.status ? { status: input.status } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    payload: input.payload ?? {},
  };
  await appendFile(demoEventsPath(rootDir), `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function publishDemoLedgerEvent(
  event: LedgerEvent,
  options: DemoEventOptions = {},
): Promise<void> {
  try {
    await publishDemoEvent(
      {
        callId: event.callId,
        type: "ledger.appended",
        stage: "ledger",
        status:
          event.policy_decision === "deny"
            ? "blocked"
            : event.policy_decision === "allow"
              ? "allowed"
              : "recorded",
        title: "Ledger event appended",
        summary: event.type,
        payload: { event },
      },
      options,
    );
  } catch {
    // Demo telemetry must never break the business path.
  }
}

export async function publishLedgerVerification(
  callId: string,
  verification: LedgerVerification,
  options: DemoEventOptions = {},
): Promise<void> {
  await publishDemoEvent(
    {
      callId,
      type: "ledger.verified",
      stage: "ledger",
      status: verification.valid ? "verified" : "failed",
      title: verification.valid ? "Hash chain verified" : "Hash chain failed",
      summary: `${verification.eventCount} events checked`,
      payload: { verification },
    },
    options,
  );
}

export async function readDemoEvents(
  options: DemoEventOptions & { callId?: string; sinceSeq?: number } = {},
): Promise<DemoEvent[]> {
  const rootDir = options.rootDir ?? process.cwd();
  let text: string;
  try {
    text = await readFile(demoEventsPath(rootDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as DemoEvent;
        if (options.callId && parsed.callId !== options.callId) {
          return [];
        }
        if (options.sinceSeq !== undefined && parsed.seq <= options.sinceSeq) {
          return [];
        }
        return [parsed];
      } catch {
        return [];
      }
    });
}

export async function readCurrentDemoCallId(
  options: DemoEventOptions = {},
): Promise<string> {
  const rootDir = options.rootDir ?? process.cwd();
  try {
    const current = JSON.parse(await readFile(demoCurrentPath(rootDir), "utf8")) as CurrentDemoRun;
    if (current.callId) {
      return current.callId;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return process.env.DEMO_CALL_ID ?? "demo_recording";
}

async function nextDemoSeq(rootDir: string): Promise<number> {
  const events = await readDemoEvents({ rootDir });
  return (events.at(-1)?.seq ?? -1) + 1;
}

async function writeCurrentDemoRun(
  callId: string,
  options: DemoEventOptions & { resetAt?: string } = {},
): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  await mkdir(demoDataDir(rootDir), { recursive: true });
  const current: CurrentDemoRun = {
    callId,
    ...(options.resetAt ? { resetAt: options.resetAt } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(demoCurrentPath(rootDir), `${JSON.stringify(current, null, 2)}\n`, "utf8");
}
