// Credential helper do git, instalado só neste repositório e só no modo bot
// (AI-08, AI-14): o push sai como a conta de máquina configurada, e nunca com a
// credencial de quem aprova. Só responde para https://github.com; para qualquer
// outro host não diz nada.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readIdentity, readToken } from './lib/identity.ts';

export function answer(request: string, token: string | undefined): string {
  const fields = new Map(
    request
      .split('\n')
      .map((line) => line.split('='))
      .filter((pair): pair is [string, string] => pair.length >= 2)
      .map(([key, ...value]) => [key, value.join('=')]),
  );
  if (fields.get('protocol') !== 'https' || fields.get('host') !== 'github.com') return '';
  // Sem token, quit=1 impede o git de consultar outro helper ou perguntar: no
  // terminal do VS Code, o askpass entregaria a sessão de quem aprova.
  if (!token) return 'quit=1\n';
  return `username=x-access-token\npassword=${token}\n`;
}

// O git chama o helper com get, store ou erase; só o get devolve credencial.
// Fora do modo bot não há token, e o quit=1 fecha a porta em vez de deixar o
// push cair em outra credencial.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv[2] === 'get') {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const identity = readIdentity(root);
  process.stdout.write(answer(readFileSync(0, 'utf8'), identity?.mode === 'bot' ? readToken(identity, root) : undefined));
}
