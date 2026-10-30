// Credential helper do git, configurado só neste repositório (AI-08): o push
// sai como o bot, e nunca com a credencial do dono, que é administradora. Só
// responde para https://github.com; para qualquer outro host não diz nada.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readBotToken } from './lib/bot-token.ts';

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
  // terminal do VS Code, o askpass entregaria a sessão do dono, que é administrador.
  if (!token) return 'quit=1\n';
  return `username=x-access-token\npassword=${token}\n`;
}

// O git chama o helper com get, store ou erase; só o get devolve credencial.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv[2] === 'get') {
  process.stdout.write(answer(readFileSync(0, 'utf8'), readBotToken()));
}
