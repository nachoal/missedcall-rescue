import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { publishDemoEvent } from "../demo-events.js";
import { createVapiWebCall } from "../services/vapi.js";
import type { CallState } from "../types/domain.js";

export type VapiRoutesOptions = {
  rootDir?: string;
  orchestrator?: OrchestratorHook;
  now?: () => Date;
};

type OrchestratorHook =
  | ((input: OrchestratorInput) => unknown)
  | {
      enqueueTriage?: (input: OrchestratorInput) => unknown;
      scheduleTriage?: (input: OrchestratorInput) => unknown;
      triageCall?: (input: OrchestratorInput) => unknown;
    };

type OrchestratorInput = {
  eventType: string;
  call: CallState;
  webhook: unknown;
};

type VapiExtraction = {
  eventType: string;
  callId: string;
  rawCallId?: string;
  callerPhone: string;
  transcript: string;
  fields: Partial<CallState>;
  warnings: string[];
};

export const vapiRoutes: FastifyPluginAsync<VapiRoutesOptions> = async (fastify, options) => {
  const handler = async (request: { body: unknown; log: FastifyInstance["log"] }, reply: FastifyReplyLike) => {
    const receivedAt = (options.now?.() ?? new Date()).toISOString();
    const extraction = extractVapiWebhook(request.body, receivedAt);
    const rootDir = resolve(options.rootDir ?? process.cwd());
    const call = await upsertCallState(rootDir, extraction, receivedAt);

    await appendWebhookTrace(rootDir, call.callId, {
      receivedAt,
      eventType: extraction.eventType,
      rawCallId: extraction.rawCallId,
      webhook: request.body,
    });
    await publishDemoEvent(
      {
        callId: call.callId,
        type: "voice.webhook",
        stage: "voice",
        status: extraction.eventType,
        title: "Vapi voice event",
        summary: extraction.transcript
          ? `${extraction.eventType}: ${extraction.transcript.length} transcript characters`
          : extraction.eventType,
        payload: {
          eventType: extraction.eventType,
          transcript: call.transcript,
          fields: extraction.fields,
          warnings: extraction.warnings,
        },
      },
      { rootDir },
    );

    const queuedTriage = triggerOrchestratorIfAvailable(
      fastify,
      options.orchestrator,
      {
        eventType: extraction.eventType,
        call,
        webhook: request.body,
      },
      request.log,
    );

    return reply.code(202).send({
      ok: true,
      accepted: true,
      callId: call.callId,
      eventType: extraction.eventType,
      status: call.status,
      transcriptChars: call.transcript.length,
      queuedTriage,
      warnings: extraction.warnings,
    });
  };

  fastify.post<{ Body: unknown }>("/vapi/webhook", handler);
  fastify.post<{ Body: unknown }>("/webhooks/vapi", handler);
  fastify.post<{ Body: unknown }>("/voice/vapi", handler);
  fastify.post<{ Body: { callId?: string; name?: string } }>("/vapi/web-call", async (request, reply) => {
    const result = await createVapiWebCall({
      callId: request.body?.callId,
      name: request.body?.name,
    });
    return reply.code(result.provider === "vapi" ? 201 : 200).send({
      ok: true,
      provider: result.provider,
      id: result.id,
      type: result.type,
      status: result.status,
      callUrl: result.callUrl,
      webCallUrl: result.webCallUrl,
      callSipUri: result.callSipUri,
    });
  });
};

export async function registerVapiRoutes(
  fastify: FastifyInstance,
  options: VapiRoutesOptions = {},
): Promise<void> {
  await fastify.register(vapiRoutes, options);
}

export default vapiRoutes;

type FastifyReplyLike = {
  code: (statusCode: number) => FastifyReplyLike;
  send: (payload: unknown) => unknown;
};

function extractVapiWebhook(body: unknown, receivedAt: string): VapiExtraction {
  const root = parseMaybeJson(body);
  const message = getRecord(root, "message") ?? getRecord(root, "event") ?? asRecord(root) ?? {};
  const call = getRecord(message, "call") ?? getRecord(root, "call") ?? {};
  const customer = getRecord(call, "customer") ?? getRecord(message, "customer") ?? getRecord(root, "customer") ?? {};
  const artifact = getRecord(message, "artifact") ?? getRecord(root, "artifact") ?? {};
  const analysis = getRecord(message, "analysis") ?? getRecord(root, "analysis") ?? {};
  const structuredData =
    getRecord(analysis, "structuredData") ??
    getRecord(message, "structuredData") ??
    getRecord(root, "structuredData") ??
    {};

  const rawCallId =
    firstString(
      getPath(root, ["callId"]),
      getPath(message, ["callId"]),
      getPath(message, ["variableValues", "callId"]),
      getPath(call, ["variableValues", "callId"]),
      getPath(message, ["call", "assistantOverrides", "variableValues", "callId"]),
      getPath(call, ["assistantOverrides", "variableValues", "callId"]),
      getPath(call, ["id"]),
      getPath(call, ["callId"]),
      getPath(root, ["id"]),
    ) ?? undefined;
  const warnings: string[] = [];
  if (!rawCallId) {
    warnings.push("Webhook did not include a call id; generated a local id.");
  }

  const callId = toSafeCallId(rawCallId ?? `vapi-${receivedAt}-${randomUUID().slice(0, 8)}`);
  const callerPhone =
    firstString(
      getPath(customer, ["number"]),
      getPath(customer, ["phoneNumber"]),
      getPath(call, ["customer", "number"]),
      getPath(call, ["phoneNumber", "number"]),
      getPath(message, ["callerPhone"]),
      getPath(root, ["callerPhone"]),
      getPath(root, ["from"]),
    ) ?? "unknown";
  const eventType =
    firstString(getPath(message, ["type"]), getPath(root, ["type"]), getPath(root, ["eventType"])) ??
    "unknown";
  const transcript = collectTranscript(root, message, artifact);

  return {
    eventType,
    callId,
    rawCallId,
    callerPhone,
    transcript,
    fields: extractCallFields(collectFieldRecords(root, message, call, customer, structuredData)),
    warnings,
  };
}

async function upsertCallState(
  rootDir: string,
  extraction: VapiExtraction,
  receivedAt: string,
): Promise<CallState> {
  const callsDir = resolve(rootDir, "data", "calls");
  await mkdir(callsDir, { recursive: true });
  const statePath = resolve(callsDir, `${extraction.callId}.json`);
  const current = await readCallState(statePath);
  const transcript = mergeTranscript(current?.transcript ?? "", extraction.transcript);
  const call: CallState = {
    callId: extraction.callId,
    callerPhone: extraction.fields.callerPhone ?? current?.callerPhone ?? extraction.callerPhone,
    customerName: extraction.fields.customerName ?? current?.customerName,
    address: extraction.fields.address ?? current?.address,
    problem: extraction.fields.problem ?? current?.problem,
    vulnerablePerson: extraction.fields.vulnerablePerson ?? current?.vulnerablePerson,
    preferredWindow: extraction.fields.preferredWindow ?? current?.preferredWindow,
    email: extraction.fields.email ?? current?.email,
    depositCheckoutUrl: current?.depositCheckoutUrl,
    stripeSessionId: current?.stripeSessionId,
    stripePaymentIntentId: current?.stripePaymentIntentId,
    bookingId: current?.bookingId,
    hermesRunId: current?.hermesRunId,
    status: current?.status ?? "triaging",
    transcript,
  };

  await writeFile(
    statePath,
    `${JSON.stringify({ ...call, updatedAt: receivedAt }, null, 2)}\n`,
    "utf8",
  );
  return call;
}

async function readCallState(path: string): Promise<(CallState & { updatedAt?: string }) | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CallState & { updatedAt?: string };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function appendWebhookTrace(
  rootDir: string,
  callId: string,
  trace: Record<string, unknown>,
): Promise<void> {
  const callsDir = resolve(rootDir, "data", "calls");
  await mkdir(callsDir, { recursive: true });
  await appendFile(resolve(callsDir, `${callId}.events.ndjson`), `${JSON.stringify(trace)}\n`, "utf8");
}

function triggerOrchestratorIfAvailable(
  fastify: FastifyInstance,
  explicitHook: OrchestratorHook | undefined,
  input: OrchestratorInput,
  log: FastifyInstance["log"],
): boolean {
  const instance = fastify as FastifyInstance & {
    orchestrator?: OrchestratorHook;
    triageOrchestrator?: OrchestratorHook;
  };
  const hook = explicitHook ?? instance.orchestrator ?? instance.triageOrchestrator;
  const action =
    typeof hook === "function"
      ? hook
      : hook?.enqueueTriage ?? hook?.scheduleTriage ?? hook?.triageCall;

  if (!action) {
    return false;
  }

  void Promise.resolve()
    .then(() => action(input))
    .catch((error: unknown) => {
      log.warn({ err: error, callId: input.call.callId }, "orchestrator triage hook failed");
    });
  return true;
}

function collectFieldRecords(
  root: unknown,
  message: Record<string, unknown>,
  call: Record<string, unknown>,
  customer: Record<string, unknown>,
  structuredData: Record<string, unknown>,
): Record<string, unknown>[] {
  const fields = [structuredData, message, call, customer, asRecord(root) ?? {}];
  const directFunctionCalls = [
    getRecord(message, "functionCall"),
    getRecord(root, "functionCall"),
    getRecord(message, "toolCall"),
    getRecord(root, "toolCall"),
  ].filter((value): value is Record<string, unknown> => Boolean(value));
  const toolCalls = firstArray(
    getPath(message, ["toolCalls"]),
    getPath(message, ["toolCallList"]),
    getPath(root, ["toolCalls"]),
    getPath(root, ["toolCallList"]),
  );

  for (const functionCall of directFunctionCalls) {
    fields.push(...extractArgumentRecords(functionCall));
  }

  for (const toolCall of toolCalls ?? []) {
    if (!isRecord(toolCall)) {
      continue;
    }
    fields.push(...extractArgumentRecords(toolCall));
    const nestedFunction = getRecord(toolCall, "function");
    if (nestedFunction) {
      fields.push(...extractArgumentRecords(nestedFunction));
    }
  }

  return fields;
}

function extractCallFields(fields: Record<string, unknown>[]): Partial<CallState> {
  const customerName = firstStringFromKeys(fields, [
    "customerName",
    "customer_name",
    "name",
    "callerName",
  ]);
  const callerPhone = firstStringFromKeys(fields, ["callerPhone", "phone", "phoneNumber", "number"]);
  const address = firstStringFromKeys(fields, ["address", "serviceAddress", "service_address"]);
  const problem = firstStringFromKeys(fields, ["problem", "issue", "serviceNeeded", "service_needed"]);
  const preferredWindow = firstStringFromKeys(fields, [
    "preferredWindow",
    "preferred_window",
    "window",
    "preferredTime",
  ]);
  const email = firstStringFromKeys(fields, ["email", "customerEmail", "customer_email"]);
  const vulnerablePerson = firstBooleanFromKeys(fields, [
    "vulnerablePerson",
    "vulnerable_person",
    "hasVulnerablePerson",
  ]);

  return {
    ...(customerName ? { customerName } : {}),
    ...(callerPhone ? { callerPhone } : {}),
    ...(address ? { address } : {}),
    ...(problem ? { problem } : {}),
    ...(preferredWindow ? { preferredWindow } : {}),
    ...(email ? { email } : {}),
    ...(vulnerablePerson === undefined ? {} : { vulnerablePerson }),
  };
}

function extractArgumentRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  return ["parameters", "arguments", "args", "input"]
    .map((key) => parseRecord(record[key]))
    .filter((value): value is Record<string, unknown> => Boolean(value));
}

function collectTranscript(
  root: unknown,
  message: Record<string, unknown>,
  artifact: Record<string, unknown>,
): string {
  const direct = firstString(
    getPath(message, ["transcript"]),
    getPath(artifact, ["transcript"]),
    getPath(root, ["transcript"]),
  );
  const messages = firstArray(
    getPath(message, ["messages"]),
    getPath(artifact, ["messages"]),
    getPath(root, ["messages"]),
  );
  const renderedMessages = messages
    ?.map((entry) => {
      if (!isRecord(entry)) {
        return undefined;
      }
      const role = firstString(entry.role, entry.speaker, entry.sender) ?? "unknown";
      const content = firstString(entry.message, entry.content, entry.text, entry.transcript);
      return content ? `${role}: ${content}` : undefined;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");

  return [direct, renderedMessages].filter(Boolean).join("\n").trim();
}

function mergeTranscript(current: string, incoming: string): string {
  const trimmedIncoming = incoming.trim();
  if (!trimmedIncoming) {
    return current;
  }
  if (!current.trim()) {
    return trimmedIncoming;
  }
  if (current.includes(trimmedIncoming)) {
    return current;
  }
  return `${current.trim()}\n${trimmedIncoming}`;
}

function toSafeCallId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.:-]/g, "_").replace(/_+/g, "_");
  return safe || `vapi-${randomUUID().slice(0, 8)}`;
}

function firstStringFromKeys(
  records: Record<string, unknown>[],
  keys: string[],
): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = firstString(record[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function firstBooleanFromKeys(
  records: Record<string, unknown>[],
  keys: string[],
): boolean | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "yes", "y", "1"].includes(normalized)) {
          return true;
        }
        if (["false", "no", "n", "0"].includes(normalized)) {
          return false;
        }
      }
    }
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

function getRecord(record: unknown, key: string): Record<string, unknown> | undefined {
  const value = asRecord(record)?.[key];
  return asRecord(value);
}

function getPath(record: unknown, path: string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(parseMaybeJson(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
