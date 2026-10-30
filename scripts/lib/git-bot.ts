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

// O hook commit-msg versionado em .githooks/ vale para qualquer commit deste
// clone. Não depende do token, então é instalado mesmo antes dele existir.
export function commitHookInstalled(root: string): boolean {
  const hooksPath = spawnSync('git', ['-C', root, 'config', '--local', '--get', 'core.hooksPath'], { encoding: 'utf8' });
  return (hooksPath.stdout ?? '').trim() === '.githooks';
}

export function installCommitHook(root: string): void {
  spawnSync('git', ['-C', root, 'config', '--local', 'core.hooksPath', '.githooks'], { encoding: 'utf8' });
}

// Modo self (AI-14): tira o helper do projeto e o valor vazio que zerava os
// helpers do sistema, para o push voltar a usar a credencial da máquina.
export function removeGitBot(root: string): void {
  spawnSync('git', ['-C', root, 'config', '--local', '--unset-all', 'credential.helper'], { encoding: 'utf8' });
}
