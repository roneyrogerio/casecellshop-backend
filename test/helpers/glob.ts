// Casamento de glob dos testes que leem a configuração do lint (.oxlintrc.json) como dado. Cada função imita uma
// decisão do oxlint, para a conferência liberar e reprovar os mesmos arquivos que o lint de verdade:
//
// - `globToRegExp` segue o `fast_glob::glob_match` 1.1.1, que o oxlint 1.90.0 traz: `*` e `?` não casam `/`; `**`
//   casa pastas; `{a,b}` vale aninhado e a vírgula fora de chaves é literal; a classe `[…]`, negada (`[!x]`, `[^x]`)
//   ou não, casa também `/`; um `!` no início do glob nega o resultado.
// - `overrideFilesMatch` segue o `GlobSet::is_match` (`crates/oxc_config/src/glob_set.rs` do oxc).
//
// A decisão do `no-restricted-imports`, que usa o `globToRegExp`, fica em `restricted-imports.ts`.
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
