import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from 'testcontainers';
import { composeImage } from './compose-image.ts';

const ELASTICMQ_PORT = 9324;

interface StartedElasticMqContainer {
  endpoint: string;
  stop(): Promise<void>;
}

// Só o contêiner, sem cliente: quem o sobe é o globalSetup da integração (FND-14), uma vez por rodada.
export async function startElasticMqContainer(): Promise<StartedElasticMqContainer> {
  // A espera é HTTP, de fora: a imagem nativa não tem shell para a checagem interna de porta do Testcontainers.
  // A mesma imagem do compose: o teste fala com o emulador que roda em produção local.
  const container: StartedTestContainer = await new GenericContainer(
    composeImage('elasticmq'),
  )
    .withExposedPorts(ELASTICMQ_PORT)
    .withWaitStrategy(
      Wait.forHttp('/?Action=ListQueues', ELASTICMQ_PORT).forStatusCodeMatching(
        (status) => status < 500,
      ),
    )
    .start();
  return {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(ELASTICMQ_PORT)}`,
    async stop() {
      await container.stop();
    },
  };
}
