import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { healthRoute, type HealthStatus } from '../contract/index.ts';
import { databaseUnavailableProblem } from '../http/problem.ts';
import { validateRequest } from '../http/validate.ts';
import type { HealthRepository } from './repository.ts';

export interface HealthRoutes {
  // Os middlewares da rota, na ordem.
  handlers: RequestHandler[];
}

export function createHealthRoutes(
  health: HealthRepository,
  logger: Logger,
): HealthRoutes {
  const getHealth: RequestHandler = async (_req, res) => {
    try {
      await health.ping();
    } catch (error) {
      logger.warn(
        { event: 'health_failed', err: error },
        'o banco não respondeu ao healthcheck',
      );
      throw databaseUnavailableProblem();
    }
    const body: HealthStatus = { status: 'ok' };
    res.json(body);
  };

  return { handlers: [validateRequest(healthRoute), getHealth] };
}
