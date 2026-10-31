import type { SQSClient } from '@aws-sdk/client-sqs';
import { pino, type Logger } from 'pino';
import { expect, vi } from 'vitest';
import type { ErpClient } from '../../src/erp/erp-client.ts';
import { createSemaphore, type Semaphore } from '../../src/outbox/semaphore.ts';
import { createReconciler, type Reconciler, type ReconcilerConfig } from '../../src/reconciliation.ts';
import type { ReceivedMessage } from '../../src/queue/sqs.ts';
import type { Telemetry } from '../../src/telemetry.ts';
import type { ManualClock } from './clock.ts';
import { countsOf, observeQueue, type ObservedQueue } from './sqs.ts';
import { waitForDlq, type QueueWorld } from './worker.ts';

// Apoio à reconciliação e ao runbook da DLQ (Fatia 3 do M3).

// Leva as `count` mensagens da fila de origem à DLQ pelo limite de recebimentos, sem worker: cada rodada
// recebe todas e as devolve na hora; o recebimento seguinte ao limite faz o SQS movê-las. Nenhum pedido
// é tocado, então o teste decide o que o banco e o ERP já sabem de cada um.
export async function moveToDlq(world: QueueWorld, count: number, maxReceiveCount: number): Promise<void> {
  const queue = world.queues.queue;
  for (let round = 1; round <= maxReceiveCount; round += 1) {
    const collected: ReceivedMessage[] = [];
    while (collected.length < count) {
      const batch = await queue.receive({ max: 10, waitSeconds: 0 });
      if (batch.length === 0) break;
      collected.push(...batch);
    }
    expect(collected, `mensagens do recebimento ${round}`).toHaveLength(count);
    for (const message of collected) expect(await queue.changeVisibility(message.receiptHandle, 0)).toBe('ok');
  }
  await vi.waitFor(
    async () => {
      expect(await queue.receive({ max: 10, waitSeconds: 0 })).toEqual([]);
      expect(await world.queues.dlq.approximateCount()).toBe(count);
    },
    { timeout: 10_000, interval: 50 },
  );
  await waitForDlq(world, count);
}

// Mensagens que seguem na DLQ, visíveis ou escondidas por um recebimento: a contagem das visíveis sozinha
// não vê a mensagem que a reconciliação recebeu e deixou lá.
export async function dlqTotal(world: QueueWorld): Promise<number> {
  const counts = await countsOf(world.emq, world.queues.dlqUrl);
  return counts.visible + counts.notVisible;
}

// Devolve à DLQ, na hora, a mensagem do pedido que a reconciliação recebeu e deixou escondida (5 min):
// o equivalente de a visibilidade vencer, sem esperar.
export async function releaseFromDlq(world: QueueWorld, dlq: ObservedQueue, orderId: string): Promise<void> {
  expect(await world.queues.dlq.changeVisibility(dlq.latestHandle(orderId), 0)).toBe('ok');
}

export interface CountingSemaphore extends Semaphore {
  // Permissões em poder de quem chamou agora: o que adquiriu menos o que devolveu.
  readonly held: number;
}

export function countingSemaphore(size: number): CountingSemaphore {
  const inner = createSemaphore(size);
  let held = 0;
  return {
    get held() {
      return held;
    },
    async acquireFree() {
      const taken = await inner.acquireFree();
      held += taken;
      return taken;
    },
    release(count) {
      held -= Math.max(0, count);
      inner.release(count);
    },
  };
}

export interface ReconcilerOptions {
  logger?: Logger;
  config?: Partial<ReconcilerConfig>;
  semaphore?: Semaphore;
  erp?: ErpClient;
  telemetry?: Telemetry;
}

export interface ReconcilerRig {
  reconciler: Reconciler;
  // A DLQ real, embrulhada para registrar o que a reconciliação recebeu e apagou.
  dlq: ObservedQueue;
  // Esperas pedidas ao relógio injetável, na ordem.
  sleeps: number[];
}

// A reconciliação sobre a DLQ real e o ERP do mundo do teste, no relógio manual.
export function buildReconciler(world: QueueWorld, options: ReconcilerOptions = {}): ReconcilerRig {
  const dlq = observeQueue(world.queues.dlq);
  const sleeps: number[] = [];
  const clock: ManualClock = {
    now: () => world.clock.now(),
    advance: (ms) => world.clock.advance(ms),
    sleep(ms) {
      sleeps.push(ms);
      return world.clock.sleep(ms);
    },
  };
  // Montada na primeira chamada, e não aqui: a preparação do teste (pedidos, mensagens na DLQ) não depende
  // da reconciliação, e uma montagem que falha não deve escondê-la.
  let instance: Reconciler | undefined;
  const current = (): Reconciler =>
    (instance ??= createReconciler({
      pool: world.pool,
      dlq,
      erp: options.erp ?? world.erp,
      semaphore: options.semaphore ?? createSemaphore(30),
      logger: options.logger ?? pino({ level: 'silent' }),
      telemetry: options.telemetry ?? world.telemetry,
      clock,
      ...(options.config ? { config: options.config } : {}),
    }));
  const reconciler: Reconciler = {
    start: () => current().start(),
    stop: () => current().stop(),
    reconcileOnce: () => current().reconcileOnce(),
  };
  return { reconciler, dlq, sleeps };
}

// Avança o relógio manual enquanto espera a promessa, para nenhuma espera do código (um intervalo, a
// pausa entre duas contagens da DLQ) segurá-la; o prazo é em tempo real, e a falha é de asserção.
export async function driveClock<T>(promise: Promise<T>, clock: ManualClock, stepMs = 1_000): Promise<T> {
  let settled = false;
  const tracked = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  tracked.catch(() => undefined);
  await vi.waitFor(
    () => {
      clock.advance(stepMs);
      expect(settled, 'a operação ainda espera o relógio').toBe(true);
    },
    { timeout: 20_000, interval: 20 },
  );
  return tracked;
}

// Nomes dos comandos que o cliente do SQS enviou: observa a fronteira sem trocar o cliente.
export function recordCommands(client: SQSClient): string[] {
  const names: string[] = [];
  client.middlewareStack.add(
    (next, context) => (args) => {
      names.push(context.commandName ?? 'desconhecido');
      return next(args);
    },
    { step: 'initialize', name: 'recordCommands' },
  );
  return names;
}
