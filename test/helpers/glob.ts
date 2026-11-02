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
//
// O oxlint valida cada glob dos `files` antes de usar (`fast_glob::validate`, chamado pelo `GlobSet::try_new`) e, se um
// for inválido, recusa a configuração inteira ("Failed to parse oxlint configuration file ... Invalid glob pattern").
// `invalidGlobReason` diz por que um glob seria recusado, e o `globToRegExp` lança um erro em vez de adivinhar um
// casamento que o oxlint nunca faria. Cobre o que a paridade em `glob.test.ts` mede: chave aberta, classe aberta e `\`
// no fim. O `validate` também recusa chaves aninhadas demais, o que a configuração não usa e a paridade não mede.
//
// Na classe `[…]`, o primeiro `]` depois do `[` e do `!` ou `^` opcional é membro, e não o fecho (medido: `a[]]b.js`
// casa `a]b.js`, e `a[]b.js` e `a[!]b.js` são recusados). A classe fecha no `]` seguinte.
//
// A `\` escapa o caractere seguinte, dentro e fora da classe (medido: `a[\]]b.js` casa `a]b.js`, `a\[b.js` casa
// `a[b.js`, `a\*b.js` casa `a*b.js`). Um `\]` não fecha a classe, e a `\` sozinha no fim é recusada. O que o `\x` vale
// segue o `unescape` do fast-glob 1.1.1 (ver `escapedChar`): `\n`, `\r`, `\t` e `\b` não são letras.
//
// O intervalo invertido (`[z-a]`) é vazio: o oxlint aceita o glob e a classe não casa nada, e a negada (`[!z-a]`) casa
// qualquer caractere (medido: `q/a[z-a]b.js` e `q/a[m-a]b.js` não casam `q/azb.js`, `q/aab.js` nem `q/amb.js`;
// `q/a[!z-a]b.js` casa todos). A regex do JavaScript recusaria o intervalo com "Range out of order", então ele sai da
// classe antes de a regex ser montada.
//
// A `}` sem `{` aberta é literal (medido: `q/a}b.js` casa `q/a}b.js`), e a `}` numa classe dentro de chaves não as
// fecha (medido: `q/{a,[}]}b.js` casa `q/ab.js` e `q/}b.js`).
interface GlobClass {
  negated: boolean;
  // Os membros já em sintaxe de classe de expressão regular: `]`, `^` e os escapados levam `\`.
  members: string;
  end: number;
}

// Um membro da classe: o trecho de regex, o código do caractere (para comparar as pontas de um intervalo) e se é o `-`
// sem escape, que é o que forma o intervalo.
interface ClassToken {
  source: string;
  code: number;
  dash: boolean;
}

// O caractere vira literal na expressão regular (fora de letras e dígitos, a `\` na frente só o torna literal).
// Os de controle (LF, CR, TAB e 0x08, que o `\n`, `\r`, `\t` e `\b` do glob produzem) vão por `\xNN`.
function escapeLiteral(char: string): string {
  const code = char.charCodeAt(0);
  if (code < 0x20) return `\\x${code.toString(16).padStart(2, '0')}`;
  return char.replace(/[^A-Za-z0-9]/g, '\\$&');
}

// O `\x` do glob, como o `unescape` do fast-glob 1.1.1 (`src/lib.rs`, tag v1.1.1) o lê, dentro e fora da classe (nas
// duas pontas de um intervalo também): `\b` é o byte 0x08, `\n` é LF, `\r` é CR, `\t` é TAB, `\a` é `a`, e qualquer
// outro caractere é ele mesmo. Devolve o trecho de expressão regular que casa só esse caractere. Medido no oxlint
// 1.90.0: `q/a\nb.js` não casa `q/anb.js`, e `q/a\ab.js` casa `q/aab.js`.
const CONTROL_ESCAPES = new Map([
  ['b', '\x08'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

// O caractere que o `\x` do glob produz (o `unescape` descrito acima).
function unescapedChar(char: string): string {
  return CONTROL_ESCAPES.get(char) ?? char;
}

function escapedChar(char: string): string {
  return escapeLiteral(unescapedChar(char));
}

function classToken(char: string, escaped: boolean): ClassToken {
  const real = escaped ? unescapedChar(char) : char;
  const literal = escaped || char === ']' || char === '^';
  return {
    source: literal ? escapeLiteral(real) : char,
    code: real.charCodeAt(0),
    dash: !escaped && char === '-',
  };
}

// Os membros em sintaxe de classe de expressão regular, sem os intervalos invertidos (vazios, como no oxlint).
function classMembers(tokens: readonly ClassToken[]): string {
  let members = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const low = tokens[index];
    const high = tokens[index + 2];
    if (low !== undefined && high !== undefined && tokens[index + 1]?.dash) {
      if (low.code <= high.code) members += `${low.source}-${high.source}`;
      index += 2;
    } else {
      members += low?.source ?? '';
    }
  }
  return members;
}

function classAt(glob: string, open: number): GlobClass | undefined {
  const negated =
    glob.charAt(open + 1) === '!' || glob.charAt(open + 1) === '^';
  const tokens: ClassToken[] = [];
  let index = open + 1 + (negated ? 1 : 0);
  // O primeiro caractere da classe, mesmo um `]`, é membro: só um `]` seguinte fecha.
  for (let first = true; index < glob.length; first = false) {
    const char = glob.charAt(index);
    if (char === ']' && !first)
      return { negated, members: classMembers(tokens), end: index };
    if (char === '\\') {
      if (index + 1 >= glob.length) return undefined;
      tokens.push(classToken(glob.charAt(index + 1), true));
      index += 2;
    } else {
      tokens.push(classToken(char, false));
      index += 1;
    }
  }
  return undefined;
}

export function invalidGlobReason(glob: string): string | undefined {
  let depth = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob.charAt(index);
    if (char === '\\') {
      if (index + 1 >= glob.length) return 'barra invertida no fim';
      index += 1;
    } else if (char === '[') {
      const charClass = classAt(glob, index);
      if (charClass === undefined)
        return 'classe de caracteres aberta (falta o "]")';
      index = charClass.end;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
    }
  }
  if (depth > 0) return 'chave aberta (falta o "}")';
  return undefined;
}

export function globToRegExp(glob: string): RegExp {
  const invalid = invalidGlobReason(glob);
  if (invalid !== undefined)
    throw new Error(
      `Glob "${glob}" inválido (${invalid}): o oxlint recusa a configuração com esse glob.`,
    );
  // Cada `!` do início inverte o casamento (`!!x` volta ao positivo, medido); o resto do glob traduz como sempre.
  const bangs = /^!*/.exec(glob)?.[0].length ?? 0;
  const negated = bangs % 2 === 1;
  const body = glob.slice(bangs);
  let source = '';
  // Quantas chaves estão abertas: um grupo já fechado não faz a vírgula seguinte virar alternativa.
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char === '\\') {
      // `\x` segue o `unescape` do fast-glob (`escapedChar`); a `\` no fim já foi recusada na validação.
      source += escapedChar(body.charAt(index + 1));
      index += 1;
    } else if (char === '*' && body.charAt(index + 1) === '*') {
      const slash = body.charAt(index + 2) === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      // Classe de caracteres (`[jt]`): os membros valem como estão (intervalos `a-c` incluídos). No glob a negação é
      // `[!…]` ou `[^…]`, e na expressão regular é `[^…]`. A classe casa a `/` também (fast-glob 1.1.1), como a da
      // regex. `]` e `^` membros e os caracteres escapados com `\` já vêm com escape, para a classe JavaScript ter o
      // mesmo conjunto.
      const charClass = classAt(body, index);
      if (charClass === undefined) throw new Error('classe aberta já validada');
      source += `[${charClass.negated ? '^' : ''}${charClass.members}]`;
      index = charClass.end;
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
export function normalizeOverrideGlob(pattern: string): string {
  const stripped = pattern.startsWith('./') ? pattern.slice(2) : pattern;
  // `./x` sem `/` fica sem o `**/`: é um glob da raiz (medido: `./*.ts` casa `x.ts`, não `sub/x.ts`).
  const rooted = stripped.includes('/') || pattern.startsWith('./');
  return rooted ? stripped : `**/${stripped}`;
}

export function overrideFilesMatch(
  files: readonly string[],
  path: string,
): boolean {
  // Compila todos antes de casar: o oxlint valida o conjunto inteiro e recusa a configuração com um glob inválido,
  // mesmo que outro padrão, antes dele, já casasse o arquivo.
  const compiled = files.map((pattern) =>
    globToRegExp(normalizeOverrideGlob(pattern)),
  );
  return compiled.some((regExp) => regExp.test(path));
}
