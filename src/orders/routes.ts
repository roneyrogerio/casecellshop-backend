import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { orderStatusRoute, type OrderStatus } from '../contract/index.ts';
import { isUnavailable } from '../db/unavailable.ts';
import { databaseUnavailableProblem, ProblemError } from '../http/problem.ts';
import { validateRequest } from '../http/validate.ts';
import { eventLogger } from '../shared/logging.ts';
import type { OrdersRepository } from './repository.ts';
import { ORDERS_LOG_EVENTS } from './telemetry.ts';

export interface OrdersRoutes {
  // Os middlewares da rota, na ordem.
  handlers: RequestHandler[];
}

export function createOrdersRoutes(
  orders: OrdersRepository,
  logger: Logger,
): OrdersRoutes {
  const getOrderStatus: RequestHandler = async (req, res) => {
    const orderId = req.params['orderId'] as string;
    let found: OrderStatus | null;
    try {
      found = await orders.findStatus(orderId);
    } catch (error) {
      // Só a falha do banco é 503; um defeito do código segue para o middleware único (500).
      if (!isUnavailable(error)) throw error;
      eventLogger(logger, ORDERS_LOG_EVENTS).warn(
        'casecellshop.orders.db.unavailable',
        { err: error },
        'o banco não respondeu à consulta do pedido',
      );
      throw databaseUnavailableProblem();
    }
    // O id fica fora do corpo do 404; o log só o recebe quando o pedido existe.
    if (!found)
      throw new ProblemError({
        status: 404,
        cause: 'not-found',
        title: 'Pedido não encontrado',
      });
    res.locals['orderId'] = found.orderId;
    res.json(found);
  };

  return { handlers: [validateRequest(orderStatusRoute), getOrderStatus] };
}
