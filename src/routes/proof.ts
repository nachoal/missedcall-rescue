import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { ProofError, renderProofPage } from "../proof.js";

export type ProofRoutesOptions = {
  rootDir?: string;
};

export const proofRoutes: FastifyPluginAsync<ProofRoutesOptions> = async (fastify, options) => {
  fastify.get<{ Params: { callId: string } }>("/proof/:callId", async (request, reply) => {
    try {
      const html = await renderProofPage(request.params.callId, { rootDir: options.rootDir });
      return reply.type("text/html; charset=utf-8").send(html);
    } catch (error) {
      if (error instanceof ProofError) {
        return reply.code(error.statusCode).send({
          ok: false,
          error: error.message,
        });
      }
      request.log.error({ err: error }, "proof render failed");
      return reply.code(500).send({
        ok: false,
        error: "Proof render failed.",
      });
    }
  });
};

export async function registerProofRoutes(
  fastify: FastifyInstance,
  options: ProofRoutesOptions = {},
): Promise<void> {
  await fastify.register(proofRoutes, options);
}

export default proofRoutes;
