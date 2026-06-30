import type { FastifyInstance } from "fastify";
import { runPostBookingDemoLoop } from "../demo-flow.js";
import { completeDepositAndBook } from "../orchestrator.js";
import { env } from "../config.js";
import { constructStripeEvent } from "../services/stripe.js";

export async function registerStripeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/stripe/webhook", async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    const rawBody = (request as { rawBody?: string }).rawBody ?? request.body;
    const event = await constructStripeEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as {
        id?: string;
        payment_intent?: string | { id?: string };
        metadata?: { call_id?: string };
      };
      const callId = session.metadata?.call_id;
      if (!callId) return reply.code(400).send({ error: "Missing call_id metadata" });
      const paymentIntentId =
        typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      const result = await completeDepositAndBook({
        callId,
        stripeSessionId: session.id,
        paymentIntentId,
        rawEvent: event
      });
      const demo = await runPostBookingDemoLoop(callId);
      return reply.send({ ok: true, result, demo });
    }

    return reply.send({ ok: true, ignored: event.type });
  });

  app.post("/stripe/webhook/replay", async (request) => {
    const body = request.body as { callId: string; stripeSessionId?: string; paymentIntentId?: string };
    const result = await completeDepositAndBook({
      callId: body.callId,
      stripeSessionId: body.stripeSessionId,
      paymentIntentId: body.paymentIntentId,
      rawEvent: body
    });
    const demo = await runPostBookingDemoLoop(body.callId);
    return { ok: true, result, demo };
  });

  app.get("/pay/success", async (request, reply) => {
    const query = request.query as { call_id?: string; session_id?: string };
    return reply.type("text/html").send(`<h1>Deposit received</h1><p>Call ${query.call_id ?? ""} is confirmed.</p>`);
  });

  app.get("/pay/cancel", async (_request, reply) => {
    return reply.type("text/html").send("<h1>Deposit canceled</h1>");
  });
}
