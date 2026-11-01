import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot as root } from '../helpers/repo-root.ts';

const read = (file: string) => readFileSync(join(root, file), 'utf8');

// Divide o Dockerfile em estágios, cada um começando no seu FROM.
function stages(dockerfile: string): string[] {
  return dockerfile
    .split(/^(?=FROM\s)/m)
    .filter((stage) => stage.startsWith('FROM'));
}

describe('certificado do proxy no build da imagem', () => {
  it('AI-51 o estágio das dependências copia o .build-ca.pem só quando ele existe', () => {
    const [deps] = stages(read('Dockerfile'));
    // O colchete é o que deixa o COPY passar com o arquivo ausente, como na máquina.
    expect(deps).toMatch(/^COPY [^\n]*\.build-ca\.pe\[m\]/m);
    expect(deps).toContain('NODE_EXTRA_CA_CERTS=/app/.build-ca.pem');
    expect(deps).toMatch(/if \[ -f \.build-ca\.pem \]/);
  });

  it('AI-51 controle: a imagem final não leva o certificado, só o node_modules do estágio anterior', () => {
    const all = stages(read('Dockerfile'));
    expect(all.length).toBeGreaterThanOrEqual(2);
    const final = all.at(-1) ?? '';
    expect(final).not.toContain('build-ca');
    expect(final).not.toContain('NODE_EXTRA_CA_CERTS');
    expect(final).toMatch(/COPY --from=deps \/app\/node_modules/);
  });

  it('AI-51 o .build-ca.pem fica fora do git e dentro do contexto do build', () => {
    const ignored = read('.gitignore')
      .split('\n')
      .map((line) => line.trim());
    expect(ignored).toContain('.build-ca.pem');
    const dockerignore = read('.dockerignore')
      .split('\n')
      .map((line) => line.trim());
    expect(dockerignore).not.toContain('.build-ca.pem');
    expect(dockerignore).not.toContain('*.pem');
  });
});
