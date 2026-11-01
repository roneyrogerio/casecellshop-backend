import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from './git-sandbox.ts';
import { isolatedEnv } from './identity-sandbox.ts';
import { runCommand } from './run-node.ts';

afterEach(() => {
  cleanupTempDirs();
});

// Condição de ambiente: o teste usa `sh` e `command -v`, que não existem no Windows. Fora dele roda sempre.
describe.skipIf(process.platform === 'win32')(
  'AI-14 o ambiente isolado dos testes nunca alcança o chaveiro real',
  () => {
    const sh = (env: Record<string, string>, script: string) =>
      runCommand('sh', ['-c', script], { env });

    it.each(['security', 'secret-tool'])(
      'AI-14 o %s do ambiente isolado é o falso, de uma pasta temporária no começo do PATH',
      (tool) => {
        const env = isolatedEnv();

        const found = sh(env, `command -v ${tool}`);

        expect(found.status).toBe(0);
        const path = found.stdout.trim();
        expect(path).toContain('fake-keychain-');
        expect(dirname(path)).toBe(env.PATH?.split(':')[0]);
      },
    );

    it.each([
      ['security', 'security find-generic-password -s x -w'],
      ['secret-tool', 'secret-tool lookup service x'],
    ])(
      'AI-14 o %s falso sai com 1 e não imprime nada, como um item inexistente',
      (_tool, command) => {
        const result = sh(isolatedEnv(), command);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
      },
    );

    it('AI-14 controle: o resto do PATH continua no ambiente isolado (o git ainda é encontrado)', () => {
      const result = sh(isolatedEnv(), 'command -v git');

      expect(result.status).toBe(0);
    });

    it('AI-14 o extra passado ao isolatedEnv ainda vale, sem desligar o chaveiro falso', () => {
      const env = isolatedEnv({ FOO: 'bar' });

      expect(env.FOO).toBe('bar');
      expect(sh(env, 'security find-generic-password -s x -w').status).toBe(1);
    });
  },
);
