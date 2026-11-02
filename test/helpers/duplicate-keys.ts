// OBS-01: o `JSON.parse` fica com a última de duas chaves iguais e esconde a repetição, então o teste lê o texto cru da
// linha. O detector percorre o JSON sem interpretá-lo e conta as chaves do primeiro nível (as de dentro de um objeto
// aninhado, como `err`, são de outro objeto e podem coincidir com as da linha).

// O fim de uma string JSON que abre em `start`: o índice da aspa que a fecha, pulando os escapes.
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === '\\' ? 2 : 1;
  }
  return index;
}

// As chaves do primeiro nível da linha, na ordem em que aparecem e com as repetidas.
export function topLevelKeys(line: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === '"') {
      const end = stringEnd(line, index);
      if (depth === 1 && expectKey)
        keys.push(JSON.parse(line.slice(index, end + 1)) as string);
      expectKey = false;
      index = end;
    } else if (char === '{' || char === '[') {
      depth += 1;
      expectKey = depth === 1 && char === '{';
    } else if (char === '}' || char === ']') {
      depth -= 1;
    } else if (char === ',') {
      expectKey = depth === 1;
    }
    index += 1;
  }
  return keys;
}

// As chaves que a linha escreve mais de uma vez no primeiro nível, sem repetir o nome na resposta.
export function duplicateKeys(line: string): string[] {
  const keys = topLevelKeys(line);
  return [...new Set(keys.filter((key, at) => keys.indexOf(key) !== at))];
}
