// Gera o openapi.yaml a partir do contrato em src/contract/. Com --check, só
// compara com o arquivo commitado e falha se divergir (FND-07).
import { readFileSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { buildOpenApiDocument } from '../src/contract/index.ts';

const target = new URL('../openapi.yaml', import.meta.url);
const header = '# Gerado por `npm run openapi` a partir de src/contract/. Não edite à mão.\n';
const generated = header + stringify(buildOpenApiDocument(), { lineWidth: 0 });

if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(target, 'utf8');
  } catch {
    // Sem arquivo, a comparação abaixo já falha com a mensagem certa.
  }
  if (committed !== generated) {
    process.stderr.write('openapi.yaml diverge do contrato em src/contract/. Rode `npm run openapi` e commite.\n');
    process.exit(1);
  }
} else {
  writeFileSync(target, generated);
}
