// PostToolUse do Edit e do Write (AI-34): formata o arquivo que acabou de ser
// editado, para o agente já trabalhar sobre o código no formato do projeto.
// Stub do PR do formatador.
import { pathToFileURL } from 'node:url';

// Devolve o caminho a formatar, ou null quando a ferramenta não editou arquivo.
export function targetToFormat(_input) {
  throw new Error('não implementado');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(0);
