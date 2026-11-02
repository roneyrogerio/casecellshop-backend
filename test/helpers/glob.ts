// Casamento de glob dos testes que leem a configuração do lint como dado (`files` dos overrides do .oxlintrc.json).
// Cobre o que a configuração usa: `*`, `**`, `**/`, `?`, classes `[jt]` e `[!x]` (negada) e grupos `{a,b}`, também
// aninhados. A vírgula só separa alternativas dentro de chaves; fora delas é um caractere comum.
export function globToRegExp(glob: string): RegExp {
  let source = '';
  // Quantas chaves estão abertas: um grupo já fechado não faz a vírgula seguinte virar alternativa.
  let depth = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob.charAt(index);
    if (char === '*' && glob.charAt(index + 1) === '*') {
      const slash = glob.charAt(index + 2) === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[' && glob.indexOf(']', index + 2) > index) {
      // Classe de caracteres (`[jt]`): vale como está, sem escapar os colchetes. No glob a negação é `[!…]`, e na
      // expressão regular é `[^…]`.
      const end = glob.indexOf(']', index + 2);
      const body = glob.slice(index + 1, end);
      source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
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
  return new RegExp(`^${source}$`);
}

// Os `files` de um override do .oxlintrc.json, como o `GlobSet` do oxlint os casa (`crates/oxc_config/src/glob_set.rs`).
export function overrideFilesMatch(
  files: readonly string[],
  path: string,
): boolean {
  void files;
  void path;
  throw new Error('não implementado');
}

// O resultado do `group` de um item do `patterns` do `no-restricted-imports`, como o oxlint o decide
// (`get_group_glob_result` em `crates/oxc_linter/src/rules/eslint/no_restricted_imports.rs`).
export type GroupResult = 'none' | 'found' | 'whitelist';

export function restrictedGroupResult(
  group: readonly string[],
  module: string,
  caseSensitive?: boolean,
): GroupResult {
  void group;
  void module;
  void caseSensitive;
  throw new Error('não implementado');
}
