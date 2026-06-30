import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";

import type { PolicyDecision, SpendRequest } from "./types/domain.js";

type PolicyDefault = "deny";

type PolicyVendor = {
  allowed: boolean;
  max_amount_cents?: number;
  currency?: SpendRequest["currency"];
  stripe_merchant_name?: string;
  allowed_purpose?: string;
  reason?: string;
};

type PolicyRule = {
  id: string;
  effect: "allow" | "deny";
  status?: 403;
};

export type PolicyConfig = {
  version: number;
  default: PolicyDefault;
  vendors: Record<string, PolicyVendor>;
  rules: PolicyRule[];
};

export type PolicyOptions = {
  policyPath?: string;
  policy?: PolicyConfig;
};

export function defaultPolicyPath(): string {
  return resolve(process.env.POLICY_PATH ?? "./policy.yaml");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function vendorFromUnknown(value: unknown): PolicyVendor | undefined {
  if (!isRecord(value) || typeof value.allowed !== "boolean") {
    return undefined;
  }

  const currency = stringField(value, "currency");
  if (currency !== undefined && currency !== "usd") {
    return undefined;
  }

  return {
    allowed: value.allowed,
    max_amount_cents: numberField(value, "max_amount_cents"),
    currency,
    stripe_merchant_name: stringField(value, "stripe_merchant_name"),
    allowed_purpose: stringField(value, "allowed_purpose"),
    reason: stringField(value, "reason"),
  };
}

function rulesFromUnknown(value: unknown): PolicyRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): PolicyRule[] => {
    if (!isRecord(item)) {
      return [];
    }

    const id = stringField(item, "id");
    const effect = stringField(item, "effect");
    const status = item.status;

    if (id === undefined || (effect !== "allow" && effect !== "deny")) {
      return [];
    }

    return [
      {
        id,
        effect,
        ...(status === 403 ? { status } : {}),
      },
    ];
  });
}

function policyFromUnknown(value: unknown): PolicyConfig {
  if (!isRecord(value)) {
    throw new Error("Policy file must contain a mapping");
  }

  const vendorsValue = value.vendors;
  if (!isRecord(vendorsValue)) {
    throw new Error("Policy file must include a vendors mapping");
  }

  const vendors: Record<string, PolicyVendor> = {};
  Object.entries(vendorsValue).forEach(([vendorName, vendorValue]) => {
    const vendor = vendorFromUnknown(vendorValue);
    if (vendor !== undefined) {
      vendors[vendorName] = vendor;
    }
  });

  return {
    version: numberField(value, "version") ?? 1,
    default: "deny",
    vendors,
    rules: rulesFromUnknown(value.rules),
  };
}

export async function loadPolicy(policyPath = defaultPolicyPath()): Promise<PolicyConfig> {
  const text = await readFile(resolve(policyPath), "utf8");
  return policyFromUnknown(parse(text));
}

function ruleId(policy: PolicyConfig, effect: "allow" | "deny", fallback: string): string {
  return policy.rules.find((rule) => rule.effect === effect)?.id ?? fallback;
}

function deny(
  policy: PolicyConfig,
  ruleIdValue: string | undefined,
  reason: string,
): PolicyDecision {
  return {
    allowed: false,
    status: 403,
    policyDecision: "deny",
    ruleId: ruleIdValue ?? ruleId(policy, "deny", "default-deny"),
    reason,
  };
}

export function evaluateSpendPolicySync(
  request: SpendRequest,
  policy: PolicyConfig,
): PolicyDecision {
  const vendor = policy.vendors[request.vendor];
  const denyRule = ruleId(policy, "deny", "default-deny");

  if (request.vendor === "google_ads") {
    return deny(policy, denyRule, vendor?.reason ?? "google_ads is not allowlisted");
  }

  if (vendor === undefined) {
    return deny(policy, denyRule, "vendor is not listed in policy.yaml");
  }

  if (!vendor.allowed) {
    return deny(policy, denyRule, vendor.reason ?? "vendor is disabled by policy");
  }

  const maxAmount = vendor.max_amount_cents;
  if (maxAmount === undefined || request.amountCents > maxAmount) {
    return deny(
      policy,
      denyRule,
      `amount exceeds policy limit for ${request.vendor}`,
    );
  }

  if (vendor.currency === undefined || request.currency !== vendor.currency) {
    return deny(policy, denyRule, "currency does not match policy allowlist");
  }

  if (
    vendor.allowed_purpose === undefined ||
    request.purpose !== vendor.allowed_purpose
  ) {
    return deny(policy, denyRule, "purpose does not match policy allowlist");
  }

  return {
    allowed: true,
    status: 200,
    policyDecision: "allow",
    ruleId: ruleId(policy, "allow", "allow-small-comms"),
  };
}

export async function evaluateSpendPolicy(
  request: SpendRequest,
  options?: PolicyOptions,
): Promise<PolicyDecision> {
  const policy = options?.policy ?? (await loadPolicy(options?.policyPath));
  return evaluateSpendPolicySync(request, policy);
}

export async function authorizeSpend(
  request: SpendRequest,
  options?: PolicyOptions,
): Promise<PolicyDecision> {
  return evaluateSpendPolicy(request, options);
}
