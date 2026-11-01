import { SpanKind } from '@opentelemetry/api';
import { sql } from 'kysely';
import type { Pool } from 'pg';
import { createDb } from '../db/database.ts';
import type { Telemetry } from '../shared/telemetry.ts';

export interface HealthRepository {
  ping(): Promise<void>;
}

// O span do repositório é CLIENT e filho do span da requisição (FND-05).
export function createHealthRepository(pool: Pool, telemetry: Telemetry): HealthRepository {
  const db = createDb(pool);
  return {
    async ping() {
      await telemetry.withSpan(
        'health.ping',
        { kind: SpanKind.CLIENT, attributes: { 'db.system.name': 'postgresql' } },
        async () => {
          await db.selectNoFrom(sql<number>`1`.as('ok')).execute();
        },
      );
    },
  };
}
