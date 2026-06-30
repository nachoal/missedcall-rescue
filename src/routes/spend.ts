import type { FastifyInstance } from "fastify";
import { writeArtifact } from "../artifacts.js";
import { appendLedger } from "../ledger.js";
import { authorizeSpend } from "../policy.js";
import { createCommsSpendAuthorization } from "../services/stripe.js";
import type { SpendRequest } from "../types/domain.js";

export async function registerSpendRoutes(app: FastifyInstance): Promise<void> {
  app.post("/spend/authorize", async (request, reply) => {
    const spend = request.body as SpendRequest;
    const decision = await authorizeSpend(spend);

    if (!decision.allowed) {
      const blocked = { ...decision, request: spend, stripeCallMade: false };
      await writeArtifact(spend.callId, "blocked_spend.json", blocked);
      await appendLedger({
        callId: spend.callId,
        type: "spend.blocked",
        amount: spend.amountCents,
        currency: spend.currency,
        policy_decision: "deny",
        payload: blocked
      });
      return reply.code(403).send(blocked);
    }

    const authorization = await createCommsSpendAuthorization(spend.callId, spend.amountCents);
    const allowed = { ...decision, request: spend, authorization };
    await writeArtifact(spend.callId, "spend_authorization.json", allowed);
    await appendLedger({
      callId: spend.callId,
      type: "spend.allowed_authorized",
      amount: spend.amountCents,
      currency: spend.currency,
      stripe_id: authorization.stripeId,
      policy_decision: "allow",
      payload: allowed
    });
    return allowed;
  });
}
