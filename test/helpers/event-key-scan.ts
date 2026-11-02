// OBS-07 (AD-029): procura a chave `event` num objeto de um arquivo TypeScript, que é como um log escreve o nome do
// evento por fora do `eventLogger`. A conferência é textual, e não pela API do TypeScript (a 7.x não tem a API em
// JavaScript): primeiro o texto perde os comentários e o conteúdo das cadeias, para um `event:` dentro de um
// comentário ou de uma mensagem não contar, e depois procura a chave na forma de objeto.

// Devolve o código sem comentários e sem o conteúdo das cadeias e dos modelos de texto. Uma cadeia cujo conteúdo é
// exatamente `event` e que está no lugar de uma chave volta como o identificador `event`, para `{ 'event': ... }`
// ser visto como a chave.
export function stripCommentsAndStrings(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      // Mantém as quebras de linha, para o número da linha do achado continuar o do arquivo.
      out += source.slice(index, stop).replace(/[^\n]/g, '');
      index = stop;
    } else if (char === '"' || char === "'" || char === '`') {
      let end = index + 1;
      while (end < source.length && source.charAt(end) !== char) {
        end += source.charAt(end) === '\\' ? 2 : 1;
      }
      const content = source.slice(index + 1, end);
      // Só a cadeia `event` que está no lugar de uma chave (seguida de `:` ou de `]:`) volta como identificador;
      // um valor ou um item de lista com esse texto não é chave.
      const isKey =
        content === 'event' &&
        /^\s*(?:\]\s*)?:/.test(source.slice(end + 1, end + 12));
      out += isKey ? 'event' : '""';
      out += content.replace(/[^\n]/g, '');
      index = end + 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

// A chave `event` de um objeto: `event: ...`, `'event': ...`, `['event']: ...` e o atalho `{ event }` ou `, event,`.
// Vem depois de `{` ou `,` (o resto, como `a ? event : b`, é uso do valor e não chave). O parâmetro `event: string`
// de uma função também casa, o que vale para quem escreve o logger e para mais ninguém.
const EVENT_KEY = /(?:[{,]\s*event\s*(?::(?!:)|[,}])|\[\s*event\s*\]\s*:)/g;

// Os números das linhas (a partir de 1) em que a chave aparece.
export function eventKeyLines(source: string): number[] {
  const code = stripCommentsAndStrings(source);
  const lines: number[] = [];
  for (const match of code.matchAll(EVENT_KEY)) {
    const keyStart = match.index + match[0].search(/event/);
    lines.push(code.slice(0, keyStart).split('\n').length);
  }
  return lines;
}
