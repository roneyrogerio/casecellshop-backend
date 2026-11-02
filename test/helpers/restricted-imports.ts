import { globMatch } from './glob.ts';

// Decisão do `no-restricted-imports` dos testes que leem a configuração do lint (.oxlintrc.json) como dado. Cada função
// imita uma decisão do oxlint 1.90.0, para a conferência reprovar os mesmos módulos que o lint de verdade:
//
// - `restrictedGroupResult` segue o `get_group_glob_result`
//   (`crates/oxc_linter/src/rules/eslint/no_restricted_imports.rs` do oxc); o casamento de cada padrão do `group` usa
//   o `globMatch` de `glob.ts`, o porte do `fast_glob::glob_match` 1.1.1. Um padrão inválido (`foo/[ab`, `foo/{ab`,
//   `foo/ab\`) não é recusado como nos `files` dos overrides: o `glob_match` devolve "não casa", a configuração é aceita
//   e o resultado do `group` não muda por ele. Medido no oxlint 1.90.0 em `restricted-imports.test.ts`.
// - `restrictedImportMatches` junta o `paths` e o `patterns` do `no-restricted-imports` como o oxlint os decide.
//
// A paridade é conferida contra o oxlint instalado em `restricted-imports.test.ts`, que roda o binário do projeto:
// quando um oxlint novo mudar a regra (ou trouxer o fast-glob 1.1.2), essa paridade reprova e o helper muda junto. Ler
// o código-fonte sozinho não basta, porque uma versão nova muda o comportamento sem aviso.

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
    // Padrão inválido não casa: o `glob_match` devolve "não casa", o oxlint aceita a configuração e o resultado não
    // muda por ele (medido na paridade). O porte faz o mesmo, sem tratamento à parte.
    if (globMatch(glob, subject)) result = negated ? 'whitelist' : 'found';
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

// O import de que se pergunta: o nome importado (`import { a } from 'x'` é `a`, `import x from 'x'` é `default`), ou
// `undefined` para o import sem nome (`import 'x'`).
type ImportName = string | undefined;

// Os nomes importados que o item trava: sem `importNames` nem `allowImportNames` o item trava o módulo todo. No import
// sem nome (medido no 1.90.0) um item com `importNames` não trava nada, e um com `allowImportNames` trava o módulo.
function namesRestricted(
  entry: RestrictionEntry,
  importName: ImportName,
): boolean {
  if (importName === undefined) return entry.importNames === undefined;
  if (entry.importNames !== undefined)
    return entry.importNames.includes(importName);
  if (entry.allowImportNames !== undefined)
    return !entry.allowImportNames.includes(importName);
  return true;
}

// Os itens do `patterns` na ordem do oxlint (medido no 1.90.0): o `group` de qualquer item, antes ou depois, é
// anulado por um padrão negado (`!x`) de algum item (o módulo sai da lista); o `regex` é conferido na hora e só é
// anulado por um padrão negado do mesmo item ou de um item ANTERIOR. O `regex` não depende do `caseSensitive`.
// Para um import com nome, um item só vale se trava o nome (`importNames`, `allowImportNames`): o padrão negado de um
// item que não o trava não anula nada (`{ group: ['foo/*', '!foo/baz'], importNames: ['a'] }` deixa
// `import { b } from 'foo/baz'` ser reprovado por outro item). No import sem nome o `group` vale sempre, o `importNames`
// do item não o limita, e o padrão negado também anula; só o `regex` respeita o `importNames`.
function patternsMatch(
  entries: readonly RestrictionEntry[],
  module: string,
  importName: ImportName,
): boolean {
  let whitelisted = false;
  let groupFound = false;
  for (const entry of entries) {
    const restricted = namesRestricted(entry, importName);
    if (restricted || importName === undefined) {
      const result = restrictedGroupResult(
        entry.group ?? [],
        module,
        entry.caseSensitive,
      );
      if (result === 'whitelist') whitelisted = true;
      if (result === 'found') groupFound = true;
    }
    const regexFound =
      restricted &&
      entry.regex !== undefined &&
      new RegExp(entry.regex).test(module);
    if (regexFound && !whitelisted) return true;
  }
  return groupFound && !whitelisted;
}

// Se o oxlint reprova o import de `importName` vindo de `module`, pelas opções do `no-restricted-imports`.
// `paths[].name` compara exato e com caixa, e um padrão negado do `patterns` não tira o módulo de um `paths`.
export function restrictedImportMatches(
  options: RestrictionOptions,
  module: string,
  importName: ImportName,
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
