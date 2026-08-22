import type { FastifyReply } from "fastify";

/** Send JSON error body compatible with existing `{ detail }` clients. */
export function sendProblem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply {
  return reply.status(status).send({
    detail: detail ?? title,
    title,
    status,
  });
}
