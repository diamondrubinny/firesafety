import type { FastifyPluginAsync } from 'fastify';
import { HttpError, unauthorized } from '../lib/errors.js';

/** Live notifications. Cookie-authenticated; Origin is checked to prevent cross-site WebSocket hijacking. */
export const wsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (req) => {
        if (req.headers.origin !== app.config.PUBLIC_ORIGIN) throw new HttpError(403, 'bad_origin', 'Cross-origin request rejected');
        if (!req.user) throw unauthorized();
      },
    },
    async (socket, req) => {
      const token = req.cookies[app.cookieNames.session]!;
      // Clients only listen; any inbound message closes the connection.
      socket.on('message', () => socket.close(1008, 'unexpected message'));
      await app.hub.add(socket, req.user!, token);
    },
  );
};
