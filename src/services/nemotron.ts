export type NemotronRole = "system" | "user" | "assistant";

export type NemotronChatMessage = {
  role: NemotronRole;
  content: string;
};

export type NemotronJsonResult<T> = {
  data: T;
  model: string;
  rawContent: string;
  providerRunId?: string;
};

export type NemotronJsonOptions = {
  env?: NodeJS.ProcessEnv;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

type OpenAICompatibleResponse = {
  id?: string;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

const DEFAULT_NEMOTRON_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_NEMOTRON_MODEL = "nvidia/nemotron-3-ultra";

export class NemotronError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "NemotronError";
  }
}

export function envUsesMocks(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(env.USE_MOCKS ?? "").toLowerCase(),
  );
}

export function isNemotronConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !envUsesMocks(env) && Boolean(env.NVIDIA_NIM_API_KEY?.trim());
}

export function parseJsonFromModelContent<T>(content: string): T {
  const trimmed = content.trim();
  const candidates = [
    trimmed,
    fencedJson(trimmed),
    boundedJson(trimmed, "{", "}"),
    boundedJson(trimmed, "[", "]"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  throw new NemotronError("Nemotron response did not contain parseable JSON.");
}

export async function requestNemotronJson<T>(
  messages: NemotronChatMessage[],
  options: NemotronJsonOptions = {},
): Promise<NemotronJsonResult<T>> {
  const env = options.env ?? process.env;
  if (!isNemotronConfigured(env)) {
    throw new NemotronError("Nemotron is not configured for live calls.");
  }

  const model = options.model ?? env.NEMOTRON_MODEL ?? DEFAULT_NEMOTRON_MODEL;
  const endpoint = `${baseUrl(env)}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.NVIDIA_NIM_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 900,
      response_format: { type: "json_object" },
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new NemotronError(
      `Nemotron chat completion failed with ${response.status}: ${errorText}`,
    );
  }

  const payload = (await response.json()) as OpenAICompatibleResponse;
  const content = extractAssistantContent(payload);
  return {
    data: parseJsonFromModelContent<T>(content),
    model,
    rawContent: content,
    providerRunId: payload.id,
  };
}

function baseUrl(env: NodeJS.ProcessEnv): string {
  return (env.NEMOTRON_BASE_URL ?? DEFAULT_NEMOTRON_BASE_URL).replace(/\/+$/, "");
}

function extractAssistantContent(payload: OpenAICompatibleResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return "";
      })
      .join("");
    if (text.trim()) {
      return text;
    }
  }

  throw new NemotronError("Nemotron response was missing assistant content.");
}

function fencedJson(content: string): string | undefined {
  return content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
}

function boundedJson(
  content: string,
  open: "{" | "[",
  close: "}" | "]",
): string | undefined {
  const start = content.indexOf(open);
  const end = content.lastIndexOf(close);
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return content.slice(start, end + 1);
}
