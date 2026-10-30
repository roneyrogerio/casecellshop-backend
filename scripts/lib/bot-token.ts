// Lê o token da conta de máquina do bot no chaveiro do sistema, sem nunca
// imprimi-lo. É a única fonte do token: o MCP (headersHelper) e o git
// (credential helper) passam por aqui, e nenhum dos dois o grava em disco.
import { spawnSync } from 'node:child_process';

export const BOT_LOGIN = process.env.BOT_LOGIN ?? 'honeyforge-bot';
export const BOT_KEYCHAIN_SERVICE = process.env.BOT_KEYCHAIN_SERVICE ?? 'loja-honeyforge-bot';

export function readBotToken(): string | undefined {
  const lookup =
    process.platform === 'darwin'
      ? spawnSync('security', ['find-generic-password', '-s', BOT_KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8' })
      : spawnSync('secret-tool', ['lookup', 'service', BOT_KEYCHAIN_SERVICE], { encoding: 'utf8' });
  const token = lookup.status === 0 ? lookup.stdout.trim() : '';
  return token || undefined;
}
