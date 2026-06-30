type Env = NodeJS.ProcessEnv;

export type VapiServiceOptions = {
  env?: Env;
  fetch?: typeof fetch;
};

export type VapiWebCallInput = {
  name?: string;
  callId?: string;
  publicBaseUrl?: string;
  serverUrl?: string;
  variableValues?: Record<string, string | number | boolean>;
};

export type VapiWebCallResult = {
  provider: "mock" | "vapi";
  id: string;
  type: string;
  status?: string;
  callUrl?: string;
  webCallUrl?: string;
  callSipUri?: string;
  raw: Record<string, unknown>;
};

const DEFAULT_VAPI_BASE_URL = "https://api.vapi.ai";
const DEFAULT_SERVER_MESSAGES = [
  "conversation-update",
  "end-of-call-report",
  "transcript",
  "tool-calls",
];

export function shouldUseVapi(env: Env = process.env): boolean {
  return env.USE_MOCKS === "false" && Boolean(env.VAPI_API_KEY?.trim() && env.VAPI_PUBLIC_KEY?.trim() && env.VAPI_ASSISTANT_ID?.trim());
}

export async function createVapiWebCall(
  input: VapiWebCallInput = {},
  options: VapiServiceOptions = {},
): Promise<VapiWebCallResult> {
  const env = options.env ?? process.env;
  if (!shouldUseVapi(env)) {
    const id = `vapi_mock_${safeSlug(input.callId ?? input.name ?? "web-call")}`;
    return {
      provider: "mock",
      id,
      type: "webCall",
      status: "queued",
      callUrl: `${env.PUBLIC_BASE_URL ?? "http://localhost:8788"}/mock/vapi/web-call/${id}`,
      webCallUrl: `${env.PUBLIC_BASE_URL ?? "http://localhost:8788"}/mock/vapi/web-call/${id}`,
      raw: {
        id,
        type: "webCall",
        status: "queued",
      },
    };
  }

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${baseUrl(env)}/call/web`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.VAPI_PUBLIC_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildWebCallPayload(input, env)),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Vapi web call failed with ${response.status}: ${safeErrorPayload(payload)}`);
  }

  return normalizeVapiWebCall(payload);
}

export async function getVapiAssistant(
  assistantId: string,
  options: VapiServiceOptions = {},
): Promise<{ ok: true; id: string; name?: string; raw: Record<string, unknown> }> {
  const env = options.env ?? process.env;
  if (!env.VAPI_API_KEY?.trim()) {
    throw new Error("VAPI_API_KEY is required.");
  }

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${baseUrl(env)}/assistant/${encodeURIComponent(assistantId)}`, {
    headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Vapi assistant probe failed with ${response.status}: ${safeErrorPayload(payload)}`);
  }

  return {
    ok: true,
    id: stringValue(payload.id) ?? assistantId,
    name: stringValue(payload.name),
    raw: pick(payload, ["id", "name", "createdAt", "updatedAt"]),
  };
}

export async function listVapiPhoneNumbers(
  options: VapiServiceOptions = {},
): Promise<{ ok: true; count: number; ids: string[] }> {
  const env = options.env ?? process.env;
  if (!env.VAPI_API_KEY?.trim()) {
    throw new Error("VAPI_API_KEY is required.");
  }

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${baseUrl(env)}/phone-number`, {
    headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` },
  });
  const payload = (await response.json().catch(() => [])) as unknown;
  if (!response.ok) {
    throw new Error(`Vapi phone-number probe failed with ${response.status}: ${safeErrorPayload(asRecord(payload))}`);
  }

  const rows = Array.isArray(payload) ? payload : [];
  const ids = rows.flatMap((row) => {
    const id = stringValue(asRecord(row).id);
    return id ? [id] : [];
  });
  return { ok: true, count: rows.length, ids };
}

function buildWebCallPayload(input: VapiWebCallInput, env: Env): Record<string, unknown> {
  const publicBaseUrl = input.publicBaseUrl ?? env.PUBLIC_BASE_URL ?? "";
  const serverUrl = input.serverUrl ?? serverUrlFor(publicBaseUrl);
  const assistantOverrides: Record<string, unknown> = {
    serverMessages: DEFAULT_SERVER_MESSAGES,
    variableValues: {
      source: "missedcall_rescue",
      ...(input.callId ? { callId: input.callId } : {}),
      ...(input.variableValues ?? {}),
    },
  };

  if (serverUrl) {
    assistantOverrides.server = {
      url: serverUrl,
      ...(env.VAPI_WEBHOOK_SECRET?.trim()
        ? { headers: { "x-vapi-webhook-secret": env.VAPI_WEBHOOK_SECRET.trim() } }
        : {}),
    };
  }

  return {
    assistantId: env.VAPI_ASSISTANT_ID,
    roomDeleteOnUserLeaveEnabled: true,
    assistantOverrides,
  };
}

function normalizeVapiWebCall(payload: Record<string, unknown>): VapiWebCallResult {
  const transport = asRecord(payload.transport);
  const callUrl =
    stringValue(payload.webCallUrl) ??
    stringValue(payload.callUrl) ??
    stringValue(transport.callUrl);
  const callSipUri =
    stringValue(payload.callSipUri) ??
    stringValue(transport.callSipUri);

  return {
    provider: "vapi",
    id: stringValue(payload.id) ?? "",
    type: stringValue(payload.type) ?? "webCall",
    status: stringValue(payload.status),
    callUrl,
    webCallUrl: callUrl,
    callSipUri,
    raw: {
      id: stringValue(payload.id),
      type: stringValue(payload.type),
      status: stringValue(payload.status),
      transport: pick(transport, ["provider", "callUrl", "callSipUri"]),
      assistantId: stringValue(payload.assistantId),
      createdAt: stringValue(payload.createdAt),
    },
  };
}

function serverUrlFor(publicBaseUrl: string): string | undefined {
  if (!publicBaseUrl) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    return undefined;
  }

  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    return undefined;
  }

  return new URL("/voice/vapi", url).toString();
}

function baseUrl(env: Env): string {
  return (env.VAPI_BASE_URL ?? DEFAULT_VAPI_BASE_URL).replace(/\/+$/, "");
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.slice(0, 40) || "call";
}

function safeErrorPayload(payload: Record<string, unknown>): string {
  return JSON.stringify({
    error: payload.error,
    message: payload.message,
    statusCode: payload.statusCode,
  });
}

function pick(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) {
      output[key] = record[key];
    }
  }
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
