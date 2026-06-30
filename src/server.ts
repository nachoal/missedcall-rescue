import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { env } from "./config.js";
import { ensureDataDirs } from "./store.js";
import { startTracerCall } from "./orchestrator.js";
import { registerDemoRoutes } from "./routes/demo.js";
import { registerStripeRoutes } from "./routes/stripe.js";
import { registerSpendRoutes } from "./routes/spend.js";
import { registerProofRoutes } from "./routes/proof.js";
import { registerVapiRoutes } from "./routes/vapi.js";
import { registerWebRoutes } from "./routes/web.js";

export async function buildServer() {
  await ensureDataDirs();
  const app = Fastify({ logger: true });
  await app.register(formbody);

  // Preserve the raw request body so Stripe webhook signature verification works.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      (req as { rawBody?: string }).rawBody = body as string;
      try {
        done(null, body && (body as string).length ? JSON.parse(body as string) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get("/health", async () => ({
    ok: true,
    service: "missedcall-rescue",
    useMocks: env.USE_MOCKS
  }));

  await registerWebRoutes(app);
  await registerDemoRoutes(app);
  await registerStripeRoutes(app);
  await registerSpendRoutes(app);
  await registerProofRoutes(app);
  await registerVapiRoutes(app, {
    orchestrator: {
      enqueueTriage: async ({ eventType, call }) => {
        if (eventType !== "end-of-call-report") {
          return;
        }
        await startTracerCall(call);
      },
    },
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}
