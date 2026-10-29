import { SpanKind } from '@opentelemetry/api';
import type { Pool } from 'pg';
import type { Telemetry } from '../telemetry.ts';

export interface HealthRepository {
  ping(): Promise<void>;
}

// O span do repositório é CLIENT e filho do span da requisição (FND-05).
export function createHealthRepository(pool: Pool, telemetry: Telemetry): HealthRepository {
  return {
    async ping() {
      await telemetry.withSpan(
        'health.ping',
        { kind: SpanKind.CLIENT, attributes: { 'db.system.name': 'postgresql' } },
        async () => {
          await pool.query('SELECT 1');
        },
      );
    },
  };
}
