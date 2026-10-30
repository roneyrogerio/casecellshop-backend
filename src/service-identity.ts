export interface ServiceIdentity {
  service: string;
  env: string;
  version: string;
}

// Fonte única da marcação unificada de serviço: o recurso dos traces e os logs
// leem daqui, para o Datadog ligar log e trace pelos mesmos valores.
export function resolveServiceIdentity(defaultName: string): ServiceIdentity {
  return {
    // OTEL_SERVICE_NAME vence, como no padrão do OpenTelemetry; o nome do processo vale fora do compose.
    service: process.env['OTEL_SERVICE_NAME'] ?? defaultName,
    env: process.env['DEPLOY_ENV'] ?? 'development',
    version: process.env['SERVICE_VERSION'] ?? '0.0.0',
  };
}
