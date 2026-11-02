// Casamento de glob dos testes que leem a configuração do lint (.oxlintrc.json) como dado. Cada função imita uma
// decisão do oxlint, para a conferência liberar e reprovar os mesmos arquivos e módulos que o lint de verdade:
//
// - `globToRegExp` segue o `fast_glob::glob_match` 1.1.1, que o oxlint 1.90.0 traz: `*` e `?` não casam `/`; `**`
//   casa pastas; `{a,b}` vale aninhado e a vírgula fora de chaves é literal; a classe `[…]`, negada (`[!x]`, `[^x]`)
//   ou não, casa também `/`; um `!` no início do glob nega o resultado.
// - `overrideFilesMatch` segue o `GlobSet::is_match` (`crates/oxc_config/src/glob_set.rs` do oxc).
// - `restrictedGroupResult` segue o `get_group_glob_result`
//   (`crates/oxc_linter/src/rules/eslint/no_restricted_imports.rs` do oxc).
// - `restrictedImportMatches` junta o `paths` e o `patterns` do `no-restricted-imports` como o oxlint os decide.
//
// A paridade é conferida contra o oxlint instalado em `glob.test.ts`, que roda o binário do projeto: quando um oxlint
// novo trouxer o fast-glob 1.1.2 (em que a classe não casa `/`), essa paridade reprova e o helper muda junto. Ler o
// código-fonte sozinho não basta, porque uma versão nova muda o comportamento sem aviso.
export function globToRegExp(glob: string): RegExp {
  // Cada `!` do início inverte o casamento (`!!x` volta ao positivo, medido); o resto do glob traduz como sempre.
  const bangs = /^!*/.exec(glob)?.[0].length ?? 0;
  const negated = bangs % 2 === 1;
  const body = glob.slice(bangs);
  let source = '';
  // Quantas chaves estão abertas: um grupo já fechado não faz a vírgula seguinte virar alternativa.
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char === '*' && body.charAt(index + 1) === '*') {
      const slash = body.charAt(index + 2) === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[' && body.indexOf(']', index + 2) > index) {
      // Classe de caracteres (`[jt]`): vale como está, sem escapar os colchetes. No glob a negação é `[!…]`, e na
      // expressão regular é `[^…]`. A classe casa a `/` também (fast-glob 1.1.1), como a classe da regex.
      const end = body.indexOf(']', index + 2);
      const inside = body.slice(index + 1, end);
      source += `[${inside.startsWith('!') ? `^${inside.slice(1)}` : inside}]`;
      index = end;
    } else if (char === '{') {
      depth += 1;
      source += '(?:';
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      source += ')';
    } else if (char === ',' && depth > 0) {
      source += '|';
    } else {
      source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  // A negação vira uma olhada à frente: a expressão regular não tem "tudo menos isto" de outro jeito.
  return new RegExp(negated ? `^(?!(?:${source})$)` : `^${source}$`);
}

// Os `files` de um override do .oxlintrc.json, como o `GlobSet` do oxlint os casa. Cada padrão perde o `./` do início;
// com `/` fica igual; `./x` sem `/` vira `x`, sem o `**/`, então só casa na raiz (o oxlint o mede como glob, não como
// nome exato: `./*.ts` casa `x.ts`); qualquer outro padrão sem `/` ganha `**/` na frente, então `*.ts` alcança `.ts`
// em qualquer pasta (diferente do glob cru, que só alcançaria a raiz). O `!` do início não conta como `/`: um `!*.ts`
// vira `**/!*.ts`, o que o oxlint também faz.
export function overrideFilesMatch(
  files: readonly string[],
  path: string,
): boolean {
  return files.some((pattern) => {
    const stripped = pattern.startsWith('./') ? pattern.slice(2) : pattern;
    // `./x` sem `/` fica sem o `**/`: é um glob da raiz (medido: `./*.ts` casa `x.ts`, não `sub/x.ts`).
    const rooted = stripped.includes('/') || pattern.startsWith('./');
    return globToRegExp(rooted ? stripped : `**/${stripped}`).test(path);
  });
}

// O oxlint passa padrão e módulo para minúsculas ASCII (não as letras acentuadas) quando o item não pede caixa.
function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

// O resultado do `group` de um item do `patterns` do `no-restricted-imports`, como o oxlint o decide
// (`get_group_glob_result`): parte de `none`, e cada padrão que casa, na ordem, vira `whitelist` (padrão com `!`) ou
// `found`; vale o último que casa. Um padrão sem `/` ganha `**/` na frente.
export type GroupResult = 'none' | 'found' | 'whitelist';

export function restrictedGroupResult(
  group: readonly string[],
  module: string,
  caseSensitive?: boolean,
): GroupResult {
  let result: GroupResult = 'none';
  const subject = caseSensitive === true ? module : asciiLowerCase(module);
  for (const raw of group) {
    const negated = raw.startsWith('!');
    const bare = negated ? raw.slice(1) : raw;
    const withFolders = bare.includes('/') ? bare : `**/${bare}`;
    const glob =
      caseSensitive === true ? withFolders : asciiLowerCase(withFolders);
    if (globToRegExp(glob).test(subject))
      result = negated ? 'whitelist' : 'found';
  }
  return result;
}

export interface RestrictionEntry {
  name?: string;
  group?: string[];
  regex?: string;
  caseSensitive?: boolean;
  importNames?: string[];
  allowImportNames?: string[];
  message?: string;
}

export interface RestrictionOptions {
  paths?: (string | RestrictionEntry)[];
  patterns?: (string | RestrictionEntry)[];
}

// Uma string solta em `patterns` é um `group` de um padrão só; em `paths` é o nome do módulo.
function patternEntry(entry: string | RestrictionEntry): RestrictionEntry {
  return typeof entry === 'string' ? { group: [entry] } : entry;
}

function pathEntry(entry: string | RestrictionEntry): RestrictionEntry {
  return typeof entry === 'string' ? { name: entry } : entry;
}

// Os nomes importados que o item trava: sem `importNames` nem `allowImportNames` o item trava o módulo todo.
function namesRestricted(entry: RestrictionEntry, importName: string): boolean {
  if (entry.importNames !== undefined)
    return entry.importNames.includes(importName);
  if (entry.allowImportNames !== undefined)
    return !entry.allowImportNames.includes(importName);
  return true;
}

// Os itens do `patterns` na ordem do oxlint (medido no 1.90.0): o `group` de qualquer item, antes ou depois, é
// anulado por um padrão negado (`!x`) de algum item (o módulo sai da lista); o `regex` é conferido na hora e só é
// anulado por um padrão negado do mesmo item ou de um item ANTERIOR. O `regex` não depende do `caseSensitive`.
function patternsMatch(
  entries: readonly RestrictionEntry[],
  module: string,
  importName: string,
): boolean {
  let whitelisted = false;
  let groupFound = false;
  for (const entry of entries) {
    const result = restrictedGroupResult(
      entry.group ?? [],
      module,
      entry.caseSensitive,
    );
    if (result === 'whitelist') whitelisted = true;
    if (!namesRestricted(entry, importName)) continue;
    if (result === 'found') groupFound = true;
    const regexFound =
      entry.regex !== undefined && new RegExp(entry.regex).test(module);
    if (regexFound && !whitelisted) return true;
  }
  return groupFound && !whitelisted;
}

// Se o oxlint reprova o import de `importName` vindo de `module`, pelas opções do `no-restricted-imports`.
// `paths[].name` compara exato e com caixa, e um padrão negado do `patterns` não tira o módulo de um `paths`.
export function restrictedImportMatches(
  options: RestrictionOptions,
  module: string,
  importName: string,
): boolean {
  const inPaths = (options.paths ?? [])
    .map(pathEntry)
    .some(
      (entry) => entry.name === module && namesRestricted(entry, importName),
    );
  return (
    inPaths ||
    patternsMatch(
      (options.patterns ?? []).map(patternEntry),
      module,
      importName,
    )
  );
}
