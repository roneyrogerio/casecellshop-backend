// O que os hooks gravam para o github-guard conferir, sem passar pela sessão
// principal: o relatório do reviewer (AI-15), dividido entre o PostToolUse do
// SubagentHandback (revisor em segundo plano) e o hook de parada (em primeiro
// plano), e os commits em que o /security-review abriu (AI-16).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function securityReviewDir(projectDir) {
  return join(projectDir, '.claude', 'state', 'security-review');
}

// O agent_id vira nome de arquivo: nada fora de [\w.-], e nenhum "." no início,
// para não sair da pasta nem criar arquivo oculto.
function fileName(agentId) {
  return String(agentId ?? 'reviewer')
    .replaceAll(/[^\w.-]/g, '_')
    .replace(/^\.+/, '_');
}

export function saveReview(projectDir, agentId, text) {
  const dir = join(projectDir, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${fileName(agentId)}.md`), text);
}

// Fora do projeto, como os contadores do hook de parada: a marca só decide se a
// parada grava o texto de encerramento, e uma marca falsa não muda relatório.
const HANDBACK_DIR = join(tmpdir(), 'casecellshop-handback');

function handbackMark(projectDir, agentId) {
  const key = createHash('sha256').update(`${projectDir}\0${String(agentId)}`).digest('hex');
  return join(HANDBACK_DIR, key);
}

// Depois do SubagentHandback, a mensagem final do mesmo agente é só o texto de
// encerramento: a marca diz à parada daquela execução que o relatório já chegou.
export function markHandback(projectDir, agentId) {
  mkdirSync(HANDBACK_DIR, { recursive: true });
  writeFileSync(handbackMark(projectDir, agentId), '');
}

// A parada consome a marca, para que uma retomada sem SubagentHandback volte a
// gravar a mensagem final.
export function takeHandback(projectDir, agentId) {
  const mark = handbackMark(projectDir, agentId);
  if (!existsSync(mark)) return false;
  rmSync(mark, { force: true });
  return true;
}
