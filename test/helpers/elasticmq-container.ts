import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from 'testcontainers';

// A mesma imagem do compose (STATE.md, "Escolhas de ferramenta"): o teste fala com o emulador que roda em produção local.
const ELASTICMQ_IMAGE = 'softwaremill/elasticmq-native:1.7.1';
const ELASTICMQ_PORT = 9324;

interface StartedElasticMqContainer {
  endpoint: string;
  stop(): Promise<void>;
}

// Só o contêiner, sem cliente: quem o sobe é o globalSetup da integração (FND-14), uma vez por rodada.
export async function startElasticMqContainer(): Promise<StartedElasticMqContainer> {
  // A espera é HTTP, de fora: a imagem nativa não tem shell para a checagem interna de porta do Testcontainers.
  const container: StartedTestContainer = await new GenericContainer(
    ELASTICMQ_IMAGE,
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
