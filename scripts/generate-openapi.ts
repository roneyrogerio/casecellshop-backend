// Gera o openapi.yaml a partir do contrato em src/contract/. Com --check, só
// compara com o arquivo commitado e falha se divergir (FND-07). O --file troca
// o arquivo comparado, para o teste provar que a divergência é detectada.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { buildOpenApiDocument } from '../src/contract/index.ts';

const fileIndex = process.argv.indexOf('--file');
const target =
  fileIndex === -1
    ? new URL('../openapi.yaml', import.meta.url)
    : resolve(process.argv[fileIndex + 1] ?? '');
const header =
  '# Gerado por `npm run openapi` a partir de src/contract/. Não edite à mão.\n';
const generated = header + stringify(buildOpenApiDocument(), { lineWidth: 0 });

if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(target, 'utf8');
  } catch {
    // Sem arquivo, a comparação abaixo já falha com a mensagem certa.
  }
  if (committed !== generated) {
    process.stderr.write(
      'openapi.yaml diverge do contrato em src/contract/. Rode `npm run openapi` e commite.\n',
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, generated);
}
