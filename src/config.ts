import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const STRIPE_TEST_SECRET_PREFIX = ["sk", "test"].join("_") + "_";

const envSchema = z.object({
  PUBLIC_BASE_URL: z.string().default("http://localhost:8788"),
  PORT: z.coerce.number().int().positive().default(8788),
  USE_MOCKS: z
    .string()
    .default("true")
    .transform((value) => value === "true" || value === "1"),

  VAPI_PUBLIC_KEY: z.string().optional().default(""),
  VAPI_API_KEY: z.string().optional().default(""),
  VAPI_ASSISTANT_ID: z.string().optional().default(""),
  VAPI_PHONE_NUMBER_ID: z.string().optional().default(""),
  VAPI_WEBHOOK_SECRET: z.string().optional().default(""),

  STRIPE_SECRET_KEY: z.string().optional().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(""),
  STRIPE_SUCCESS_URL: z.string().default("http://localhost:8788/pay/success"),
  STRIPE_CANCEL_URL: z.string().default("http://localhost:8788/pay/cancel"),
  STRIPE_ISSUING_CARDHOLDER_ID: z.string().optional().default(""),
  STRIPE_ISSUING_CARD_ID: z.string().optional().default(""),

  CAL_API_KEY: z.string().optional().default(""),
  CAL_EVENT_TYPE_ID: z.string().optional().default(""),
  CAL_API_VERSION: z.string().optional().default("2024-08-13"),
  CAL_SLOTS_API_VERSION: z.string().optional().default("2024-06-14"),
  CAL_TIMEZONE: z.string().default("America/New_York"),

  TWILIO_ACCOUNT_SID: z.string().optional().default(""),
  TWILIO_AUTH_TOKEN: z.string().optional().default(""),
  TWILIO_FROM_NUMBER: z.string().optional().default(""),

  NVIDIA_NIM_API_KEY: z.string().optional().default(""),
  NEMOTRON_MODEL: z.string().default("nvidia/nemotron-3-ultra"),
  NEMOTRON_BASE_URL: z.string().default("https://integrate.api.nvidia.com/v1"),

  HERMES_BASE_URL: z.string().default("http://127.0.0.1:8789"),
  HERMES_PROFILE: z.string().default("missedcall-rescue"),

  POLICY_PATH: z.string().default("./policy.yaml"),
  LEDGER_PATH: z.string().default("./data/events.jsonl")
});

export const env = envSchema.parse(process.env);

export function hasRealStripeKey(): boolean {
  return !env.USE_MOCKS && env.STRIPE_SECRET_KEY.startsWith(STRIPE_TEST_SECRET_PREFIX);
}

export function hasCalConfig(): boolean {
  return !env.USE_MOCKS && Boolean(env.CAL_API_KEY && env.CAL_EVENT_TYPE_ID);
}

export function hasTwilioConfig(): boolean {
  return !env.USE_MOCKS && Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
}

export function hasNimConfig(): boolean {
  return !env.USE_MOCKS && Boolean(env.NVIDIA_NIM_API_KEY);
}
