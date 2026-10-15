import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  app.get('/readyz', { config: { rateLimit: false } }, async (req, reply) => {
    try {
      await app.db.query('SELECT 1');
      return { status: 'ready' };
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      return reply.status(503).send({ status: 'unavailable' });
    }
  });
};
