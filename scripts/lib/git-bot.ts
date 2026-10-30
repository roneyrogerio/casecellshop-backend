// Configura o push deste repositório para sair como o bot. Fica em .git/config,
// só neste clone; o valor vazio antes zera os helpers do sistema e do usuário
// (como o osxkeychain), para o push nunca cair na credencial do dono.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function gitHelperIsBot(root: string): boolean {
  const helpers = spawnSync('git', ['-C', root, 'config', '--local', '--get-all', 'credential.helper'], { encoding: 'utf8' });
  return (helpers.stdout ?? '').includes('git-credential-bot');
}

export function configureGitBot(root: string): void {
  const git = (...args: string[]) => spawnSync('git', ['-C', root, 'config', '--local', ...args], { encoding: 'utf8' });
  git('--unset-all', 'credential.helper');
  git('--add', 'credential.helper', '');
  git('--add', 'credential.helper', `!node "${join(root, 'scripts', 'git-credential-bot.ts')}"`);
}
