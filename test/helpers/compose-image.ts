import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './repo-root.ts';

interface ComposeImages {
  services?: Record<string, { image?: string } | undefined>;
}

// A imagem de um serviço do compose.yaml, para os contêineres dos testes usarem a mesma versão que roda no compose
// (STATE.md, "Escolhas de ferramenta"). A versão mora só no compose.yaml: subir de versão lá sobe nos testes também.
export function composeImage(service: string): string {
  const compose = parse(
    readFileSync(join(repoRoot, 'compose.yaml'), 'utf8'),
  ) as ComposeImages;
  const image = compose.services?.[service]?.image;
  if (image === undefined)
    throw new Error(`o serviço ${service} do compose.yaml não declara image`);
  return image;
}
