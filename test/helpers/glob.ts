// Casamento de glob dos testes que leem a configuração do lint (.oxlintrc.json) como dado: um porte, byte a byte, do
// `glob_match` e do `validate` do fast-glob 1.1.1, que o oxlint 1.90.0 traz. Assim a conferência libera e reprova os
// mesmos arquivos que o lint de verdade, inclusive nos cantos em que um casador por expressão regular erra (a pilha de
// chaves, o salto de volta ao `**`, o `*` único que guarda só o último ponto de retorno).
//
// Porte de https://github.com/oxc-project/fast-glob/blob/3b6c31c39a676257fd1d95c338025b64f3f0395a/src/lib.rs
// (tag v1.1.1, commit 3b6c31c39a676257fd1d95c338025b64f3f0395a; a licença está em
// https://github.com/oxc-project/fast-glob/blob/3b6c31c39a676257fd1d95c338025b64f3f0395a/LICENSE).
// A estrutura e os nomes seguem o Rust (`State`, `Wildcard`, a pilha de chaves com limite 10, `skip_globstars`,
// `skip_to_separator`, `skip_branch`, `match_brace`, `match_start` da negação), para que uma nova versão do fast-glob
// se compare com este arquivo linha a linha.
//
// MIT License
//
// Copyright (c) 2025-present VoidZero Inc. & Contributors
// Copyright (c) 2024 shulaoda
// Copyright (c) 2023 Devon Govett
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// O que fica de fora do porte: o `overrideFilesMatch` segue o `GlobSet::is_match` (`crates/oxc_config/src/glob_set.rs`
// do oxc), e a decisão do `no-restricted-imports`, que também usa o `globMatch`, fica em `restricted-imports.ts`.
//
// Como o porte é conferido: o código-fonte lido sozinho não basta, porque uma versão nova do oxlint muda o
// comportamento sem aviso (o fast-glob 1.1.2 faz a classe deixar de casar `/`). A paridade em `glob.test.ts` roda o
// binário do projeto e compara, com casos fixos e com uma propriedade que gera globs, o que ele casa com o que o
// `overrideFilesMatch` casa. Quando ela reprova, este arquivo muda junto.

// O fast-glob trabalha em bytes (`&[u8]`), e o porte também: um `Buffer` do glob e outro do caminho. Os caracteres do
// glob que importam (`*`, `?`, `[`, `{`, `,`, `}`, `/`, `\`, `!`, `^`, `-`, `]`) são ASCII.
const BANG = 0x21;
const STAR = 0x2a;
const COMMA = 0x2c;
const DASH = 0x2d;
const SLASH = 0x2f;
const QUESTION = 0x3f;
const OPEN_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_BRACKET = 0x5d;
const CARET = 0x5e;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

// O limite da pilha de chaves (`MAX_BRACE_NESTING`): um glob com mais chaves abertas ao mesmo tempo é inválido.
const MAX_BRACE_NESTING = 10;

// O byte do glob na posição, ou -1 fora dele: o Rust entra em pânico num índice fora do vetor, e o porte nunca chega
// lá (cada leitura é protegida como no original), então -1 só serve para o TypeScript, que não conhece o limite.
function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? -1;
}

// Se os bytes a partir de `index` são os do texto ASCII (a comparação de fatias `&glob[a..b] == b"/**/"` do Rust).
function hasBytesAt(bytes: Uint8Array, index: number, text: string): boolean {
  for (let offset = 0; offset < text.length; offset += 1)
    if (byteAt(bytes, index + offset) !== text.charCodeAt(offset)) return false;
  return true;
}

// `std::path::is_separator` no Unix: só a `/`.
function isSeparator(byte: number): boolean {
  return byte === SLASH;
}

// Onde a classe `[…]` que abre em `index` termina (o índice depois do `]`), ou `undefined` se ela não fecha. O primeiro
// caractere depois do `[` e do `!` ou `^` opcional é membro, mesmo um `]` (medido: `a[]]b.js` casa `a]b.js`), e a `\`
// escapa o caractere seguinte (um `\]` não fecha a classe).
function skipClass(glob: Uint8Array, index: number): number | undefined {
  let next = index + 1;
  if (byteAt(glob, next) === CARET || byteAt(glob, next) === BANG) next += 1;
  let first = true;
  for (;;) {
    if (next >= glob.length) return undefined;
    const byte = byteAt(glob, next);
    if (byte === CLOSE_BRACKET && !first) return next + 1;
    if (byte === BACKSLASH) next += 1;
    first = false;
    next += 1;
  }
}

// Os quatro motivos do `validate`, na ordem em que o Rust os acha. O oxlint chama o `validate` em cada glob dos `files`
// (`GlobSet::try_new`) e, se um for inválido, recusa a configuração inteira ("Failed to parse oxlint configuration
// file ... Invalid glob pattern"). Os `!` do início não fazem parte do padrão. Uma `}` sem `{` aberta é um caractere
// comum (medido: `q/a}b.js` casa `q/a}b.js`).
export function invalidGlobReason(glob: string): string | undefined {
  const bytes = Buffer.from(glob);
  let index = 0;
  while (index < bytes.length && byteAt(bytes, index) === BANG) index += 1;

  let openBraces = 0;
  while (index < bytes.length) {
    const byte = byteAt(bytes, index);
    if (byte === BACKSLASH) {
      if (index + 1 >= bytes.length) return 'barra invertida no fim';
      index += 2;
    } else if (byte === OPEN_BRACKET) {
      const next = skipClass(bytes, index);
      if (next === undefined)
        return 'classe de caracteres aberta (falta o "]")';
      index = next;
    } else if (byte === OPEN_BRACE) {
      if (openBraces >= MAX_BRACE_NESTING)
        return `chaves aninhadas demais (mais de ${String(MAX_BRACE_NESTING)})`;
      openBraces += 1;
      index += 1;
    } else if (byte === CLOSE_BRACE) {
      openBraces = Math.max(0, openBraces - 1);
      index += 1;
    } else {
      index += 1;
    }
  }
  if (openBraces > 0) return 'chave aberta (falta o "}")';
  return undefined;
}

// Um ponto de retorno do `*` ou do `**`. É um valor (`Copy` no Rust): atribuir um a outro copia.
interface Wildcard {
  globIndex: number;
  pathIndex: number;
  braceDepth: number;
}

function newWildcard(): Wildcard {
  return { globIndex: 0, pathIndex: 0, braceDepth: 0 };
}

function copyWildcard(wildcard: Wildcard): Wildcard {
  return { ...wildcard };
}

// A pilha de chaves: para cada `{` em tentativa, o índice dela e o do ramo (alternativa) que está sendo casado.
type BraceStack = [openBraceIndex: number, branchIndex: number][];

// O que cada `\x` vira: `\a` é `a`, `\b` é 0x08, `\n` é LF, `\r` é CR, `\t` é TAB, e qualquer outro caractere fica fora
// da tabela e é ele mesmo (medido no oxlint: `q/a\nb.js` não casa `q/anb.js`, e `q/a\ab.js` casa `q/aab.js`).
const CONTROL_ESCAPES = new Map([
  [0x61, 0x61],
  [0x62, 0x08],
  [0x6e, 0x0a],
  [0x72, 0x0d],
  [0x74, 0x09],
]);

// Como o Rust passa `invalid_pattern` por referência (`&mut bool`), o porte passa um objeto.
interface InvalidFlag {
  value: boolean;
}

class State {
  pathIndex = 0;
  globIndex = 0;
  braceDepth = 0;
  wildcard: Wildcard = newWildcard();
  globstar: Wildcard = newWildcard();

  clone(): State {
    const copy = new State();
    copy.pathIndex = this.pathIndex;
    copy.globIndex = this.globIndex;
    copy.braceDepth = this.braceDepth;
    copy.wildcard = copyWildcard(this.wildcard);
    copy.globstar = copyWildcard(this.globstar);
    return copy;
  }

  // Volta ao último `*` guardado: o `*` consome mais um byte do caminho a cada volta.
  backtrack(): void {
    this.globIndex = this.wildcard.globIndex;
    this.pathIndex = this.wildcard.pathIndex;
    this.braceDepth = this.wildcard.braceDepth;
  }

  // Junta uma sequência de `**/**/` num só: salta os `/**/` do meio e o `/**` do fim, e deixa o `globIndex` nos dois
  // últimos `*`. O `/**` só junta se vem no fim do glob; `q/**/**b.js` não junta (o segundo `**` vira um `*`).
  skipGlobstars(glob: Uint8Array): void {
    let globIndex = this.globIndex + 2;
    while (globIndex + 4 <= glob.length && hasBytesAt(glob, globIndex, '/**/'))
      globIndex += 3;
    if (glob.length - globIndex === 3 && hasBytesAt(glob, globIndex, '/**'))
      globIndex += 3;
    this.globIndex = globIndex - 2;
  }

  // Depois de um `**` que é o trecho inteiro: o ponto de retorno passa a ser a próxima `/` do caminho (o `**` não
  // para no meio de um trecho), e vira também o ponto de retorno do `**`.
  skipToSeparator(path: Uint8Array, isEndInvalid: boolean): void {
    if (this.pathIndex === path.length) {
      this.wildcard.pathIndex += 1;
      return;
    }
    let pathIndex = this.pathIndex;
    while (pathIndex < path.length && !isSeparator(byteAt(path, pathIndex)))
      pathIndex += 1;
    if (isEndInvalid || pathIndex !== path.length) pathIndex += 1;
    this.wildcard.pathIndex = pathIndex;
    this.globstar = copyWildcard(this.wildcard);
  }

  // Salta o resto do ramo de chaves em que o casamento está, até depois da `}` que o fecha: o ramo que acabou de casar
  // não tenta os ramos seguintes (quem tenta é o `match_brace`).
  skipBranch(glob: Uint8Array): void {
    const endBraceDepth = this.braceDepth - 1;
    while (this.globIndex < glob.length) {
      const byte = byteAt(glob, this.globIndex);
      if (byte === OPEN_BRACE) {
        this.braceDepth += 1;
      } else if (byte === CLOSE_BRACE) {
        this.braceDepth -= 1;
        if (this.braceDepth === endBraceDepth) {
          this.globIndex += 1;
          return;
        }
      } else if (this.skipClassOrEscape(glob, byte)) {
        continue;
      }
      this.globIndex += 1;
    }
  }

  // O `skip_branch` e o `match_brace` andam pelo glob byte a byte e tratam igual a classe e o escape: a classe `[…]` é
  // saltada inteira (uma classe aberta engole o resto do glob, e deixa a chave aberta também), e a `\` pula o byte
  // seguinte. Devolve se o byte era uma classe, caso em que o chamador não avança mais um byte.
  skipClassOrEscape(glob: Uint8Array, byte: number): boolean {
    if (byte === OPEN_BRACKET) {
      this.globIndex = skipClass(glob, this.globIndex) ?? glob.length;
      return true;
    }
    if (byte === BACKSLASH) this.globIndex += 1;
    return false;
  }

  // Lê um `\x` em `glob[globIndex]` (o `unescape` do Rust): devolve o byte que ele produz, avançando o `globIndex` para o
  // caractere escapado, ou `undefined` (com o glob marcado como inválido) se a `\` está no fim.
  unescape(
    byte: number,
    glob: Uint8Array,
    invalidPattern: InvalidFlag,
  ): number | undefined {
    if (byte !== BACKSLASH) return byte;
    this.globIndex += 1;
    if (this.globIndex >= glob.length) {
      invalidPattern.value = true;
      return undefined;
    }
    const escaped = byteAt(glob, this.globIndex);
    return CONTROL_ESCAPES.get(escaped) ?? escaped;
  }

  // Casa o resto do glob com o caminho a partir de um ramo `branchIndex` do `{` em `openBraceIndex`, sobre uma cópia do
  // estado: o chamador continua de onde estava para tentar o próximo ramo.
  matchBraceBranch(
    glob: Uint8Array,
    path: Uint8Array,
    openBraceIndex: number,
    branchIndex: number,
    braceStack: BraceStack,
    invalidPattern: InvalidFlag,
  ): boolean {
    // Chaves aninhadas além da pilha: o glob é inválido (o `validate` também o recusa).
    if (braceStack.length >= MAX_BRACE_NESTING) {
      invalidPattern.value = true;
      return false;
    }
    braceStack.push([openBraceIndex, branchIndex]);

    const branchState = this.clone();
    branchState.globIndex = branchIndex;
    branchState.braceDepth = braceStack.length;

    const matched = branchState.globMatchFrom(
      glob,
      path,
      branchIndex,
      braceStack,
      invalidPattern,
    );

    braceStack.pop();
    return matched;
  }

  // Num `{`: tenta cada ramo (alternativa) do grupo, cada um casando o resto do glob. Casa se algum ramo casa. As
  // alternativas vazias (`{}`, `{a,}`) são ramos vazios, e a `,` e a `}` só contam no nível do próprio `{`.
  matchBrace(
    glob: Uint8Array,
    path: Uint8Array,
    braceStack: BraceStack,
    invalidPattern: InvalidFlag,
  ): boolean {
    let braceDepth = 0;
    let hasClosingBrace = false;
    let matched = false;

    const openBraceIndex = this.globIndex;
    let branchIndex = 0;

    while (this.globIndex < glob.length) {
      const byte = byteAt(glob, this.globIndex);
      if (byte === OPEN_BRACE) {
        braceDepth += 1;
        if (braceDepth === 1) branchIndex = this.globIndex + 1;
      } else if (byte === CLOSE_BRACE) {
        braceDepth -= 1;
        if (braceDepth === 0) {
          hasClosingBrace = true;
          if (
            this.matchBraceBranch(
              glob,
              path,
              openBraceIndex,
              branchIndex,
              braceStack,
              invalidPattern,
            )
          )
            matched = true;
          break;
        }
      } else if (byte === COMMA && braceDepth === 1) {
        if (
          this.matchBraceBranch(
            glob,
            path,
            openBraceIndex,
            branchIndex,
            braceStack,
            invalidPattern,
          )
        )
          matched = true;
        branchIndex = this.globIndex + 1;
      } else if (this.skipClassOrEscape(glob, byte)) {
        continue;
      }
      this.globIndex += 1;
    }

    if (!hasClosingBrace) {
      invalidPattern.value = true;
      return false;
    }
    return matched;
  }

  // O laço do casamento. A ordem dos braços do `match` do Rust importa: um braço cujo guard falha passa para o seguinte,
  // então o `?` diante de uma `/` e o `,` ou `}` fora de chaves caem no braço do literal; sem caminho, nenhum braço casa
  // e o fluxo vai para o retorno. Já o `[` que entrou e não casou vai direto para o retorno, sem cair no literal.
  globMatchFrom(
    glob: Uint8Array,
    path: Uint8Array,
    matchStart: number,
    braceStack: BraceStack,
    invalidPattern: InvalidFlag,
  ): boolean {
    while (this.globIndex < glob.length || this.pathIndex < path.length) {
      if (this.globIndex < glob.length) {
        const byte = byteAt(glob, this.globIndex);
        const hasPath = this.pathIndex < path.length;
        if (byte === STAR) {
          const isGlobstar =
            this.globIndex + 1 < glob.length &&
            byteAt(glob, this.globIndex + 1) === STAR;
          if (isGlobstar) this.skipGlobstars(glob);

          this.wildcard.globIndex = this.globIndex;
          this.wildcard.pathIndex = this.pathIndex + 1;
          this.wildcard.braceDepth = this.braceDepth;

          let inGlobstar = false;
          if (isGlobstar) {
            this.globIndex += 2;

            const isEndInvalid = this.globIndex !== glob.length;

            // O `**` é o trecho inteiro se começa um trecho (o início do glob ou do ramo, ou depois de uma `/`) e vem
            // antes de uma `/` ou do fim do glob. Em qualquer outro lugar (`q/**.js`, `a**b`, `***`) vale como um `*`.
            if (
              (Math.max(0, this.globIndex - matchStart) < 3 ||
                byteAt(glob, this.globIndex - 3) === SLASH) &&
              (!isEndInvalid || byteAt(glob, this.globIndex) === SLASH)
            ) {
              if (isEndInvalid) this.globIndex += 1;
              this.skipToSeparator(path, isEndInvalid);
              inGlobstar = true;
            }
          } else {
            this.globIndex += 1;
          }

          // O `*` que começa numa `/` não consome nada: o ponto de retorno passa a ser o do `**` anterior.
          if (
            !inGlobstar &&
            this.pathIndex < path.length &&
            isSeparator(byteAt(path, this.pathIndex))
          )
            this.wildcard = copyWildcard(this.globstar);

          continue;
        } else if (
          byte === QUESTION &&
          hasPath &&
          !isSeparator(byteAt(path, this.pathIndex))
        ) {
          this.globIndex += 1;
          this.pathIndex += 1;
          continue;
        } else if (byte === OPEN_BRACKET && hasPath) {
          this.globIndex += 1;

          let negated = false;
          if (
            this.globIndex < glob.length &&
            (byteAt(glob, this.globIndex) === CARET ||
              byteAt(glob, this.globIndex) === BANG)
          ) {
            negated = true;
            this.globIndex += 1;
          }

          let first = true;
          let isMatch = false;
          const pathByte = byteAt(path, this.pathIndex);
          while (
            this.globIndex < glob.length &&
            (first || byteAt(glob, this.globIndex) !== CLOSE_BRACKET)
          ) {
            const low = this.unescape(
              byteAt(glob, this.globIndex),
              glob,
              invalidPattern,
            );
            if (low === undefined) return false;

            this.globIndex += 1;

            // O `-` só forma intervalo logo depois de um membro e se o byte seguinte não é o `]` que fecha a classe.
            // O intervalo invertido (`z-a`) não casa nada.
            let high = low;
            if (
              this.globIndex + 1 < glob.length &&
              byteAt(glob, this.globIndex) === DASH &&
              byteAt(glob, this.globIndex + 1) !== CLOSE_BRACKET
            ) {
              this.globIndex += 1;
              const end = this.unescape(
                byteAt(glob, this.globIndex),
                glob,
                invalidPattern,
              );
              if (end === undefined) return false;
              this.globIndex += 1;
              high = end;
            }

            if (low <= pathByte && pathByte <= high) isMatch = true;

            first = false;
          }

          if (this.globIndex >= glob.length) {
            invalidPattern.value = true;
            return false;
          }

          this.globIndex += 1;
          if (isMatch !== negated) {
            this.pathIndex += 1;
            continue;
          }
          // A classe que não casou vai para o retorno, sem cair no literal. A classe casa a `/` também (fast-glob
          // 1.1.1), e a negada casa qualquer byte fora dela.
        } else if (byte === OPEN_BRACE) {
          const resumed = braceStack.find(
            ([openBraceIndex]) => openBraceIndex === this.globIndex,
          );
          if (resumed !== undefined) {
            // Voltar a um `{` já em tentativa (o retorno de um `*` de dentro do ramo) retoma o mesmo ramo.
            this.globIndex = resumed[1];
            this.braceDepth += 1;
            continue;
          }
          return this.matchBrace(glob, path, braceStack, invalidPattern);
        } else if (
          (byte === COMMA || byte === CLOSE_BRACE) &&
          this.braceDepth > 0
        ) {
          this.skipBranch(glob);
          continue;
        } else if (hasPath) {
          const literal = this.unescape(byte, glob, invalidPattern);
          if (literal === undefined) return false;

          const isMatch =
            literal === SLASH
              ? isSeparator(byteAt(path, this.pathIndex))
              : byteAt(path, this.pathIndex) === literal;

          if (isMatch) {
            this.globIndex += 1;
            this.pathIndex += 1;

            if (literal === SLASH) this.wildcard = copyWildcard(this.globstar);

            continue;
          }
        }
      }

      if (
        this.wildcard.pathIndex > 0 &&
        this.wildcard.pathIndex <= path.length
      ) {
        this.backtrack();
        continue;
      }

      return false;
    }

    return true;
  }
}

// O `glob_match_internal`: devolve se casou e se o padrão é inválido. Cada `!` do início inverte o resultado; o `!`
// não faz parte do padrão, e o `matchStart` marca onde o padrão começa (o `**` do início do glob é um trecho inteiro).
function globMatchInternal(
  glob: Uint8Array,
  path: Uint8Array,
): { matched: boolean; invalidPattern: boolean } {
  const state = new State();

  let negated = false;
  while (
    state.globIndex < glob.length &&
    byteAt(glob, state.globIndex) === BANG
  ) {
    negated = !negated;
    state.globIndex += 1;
  }

  const braceStack: BraceStack = [];
  const invalidPattern: InvalidFlag = { value: false };
  const matchStart = state.globIndex;
  const matched = state.globMatchFrom(
    glob,
    path,
    matchStart,
    braceStack,
    invalidPattern,
  );

  // Um glob negado que não casou e é inválido não casa: negar um padrão inválido não o torna válido.
  if (
    negated &&
    !matched &&
    !invalidPattern.value &&
    invalidGlobReason(Buffer.from(glob).toString()) !== undefined
  )
    return { matched: false, invalidPattern: true };

  return { matched: negated !== matched, invalidPattern: invalidPattern.value };
}

// `fast_glob::glob_match`: casa o glob com o caminho. Um glob inválido nunca casa (o oxlint, que valida antes, recusa a
// configuração; quem decide o que fazer com o glob inválido é o chamador, com o `invalidGlobReason`).
export function globMatch(glob: string, path: string): boolean {
  const result = globMatchInternal(Buffer.from(glob), Buffer.from(path));
  return result.matched && !result.invalidPattern;
}

// O glob de um `files` do .oxlintrc.json como o `GlobSet` do oxlint o prepara antes de casar. Perde o `./` do início;
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

// Se o caminho casa algum dos `files` de um override do .oxlintrc.json, como o `GlobSet` do oxlint o decide. Um glob
// inválido lança, porque o oxlint recusa a configuração inteira.
export function overrideFilesMatch(
  files: readonly string[],
  path: string,
): boolean {
  // Valida todos antes de casar: o oxlint valida o conjunto inteiro e recusa a configuração com um glob inválido,
  // mesmo que outro padrão, antes dele, já casasse o arquivo.
  const globs = files.map(normalizeOverrideGlob);
  for (const glob of globs) {
    const invalid = invalidGlobReason(glob);
    if (invalid !== undefined)
      throw new Error(
        `Glob "${glob}" inválido (${invalid}): o oxlint recusa a configuração com esse glob.`,
      );
  }
  return globs.some((glob) => globMatch(glob, path));
}
