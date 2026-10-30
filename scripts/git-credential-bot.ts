// Credential helper do git, configurado só neste repositório (AI-08): o push
// sai como o bot, e nunca com a credencial do dono, que é administradora. Só
// responde para https://github.com; para qualquer outro host não diz nada, e o
// git segue sem credencial.
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
  if (!token || fields.get('protocol') !== 'https' || fields.get('host') !== 'github.com') return '';
  return `username=x-access-token\npassword=${token}\n`;
}

// O git chama o helper com get, store ou erase; só o get devolve credencial.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv[2] === 'get') {
  process.stdout.write(answer(readFileSync(0, 'utf8'), readBotToken()));
}
