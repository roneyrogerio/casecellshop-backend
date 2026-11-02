import type { RequestHandler } from 'express';
import { healthRoute, type HealthStatus } from '../contract/index.ts';
import { databaseUnavailableProblem } from '../http/problem.ts';
import { validateRequest } from '../http/validate.ts';
import { eventLogger, type AppLogger } from '../shared/logging.ts';
import type { HealthRepository } from './repository.ts';
import { HEALTH_LOG_EVENTS } from './telemetry.ts';

export interface HealthRoutes {
  // Os middlewares da rota, na ordem.
  handlers: RequestHandler[];
}

export function createHealthRoutes(
  health: HealthRepository,
  logger: AppLogger,
): HealthRoutes {
  const getHealth: RequestHandler = async (_req, res) => {
    try {
      await health.ping();
    } catch (error) {
      eventLogger(logger, HEALTH_LOG_EVENTS).warn(
        'casecellshop.health.db.unavailable',
        { err: error },
        'o banco não respondeu ao healthcheck',
      );
      throw databaseUnavailableProblem();
    }
    const body: HealthStatus = { status: 'ok' };
    res.json(body);
  };

  return { handlers: [validateRequest(healthRoute), getHealth] };
}
