import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WAIT_GUARD_MS } from '../helpers/async.ts';
import { repoRoot } from '../helpers/repo-root.ts';

// FND-13: as esperas por um efeito do worker, do relay ou da reconciliação não dependem da carga da máquina.
// Duas regras sobre o texto dos testes de faturamento e dos ajudantes deles: nenhuma espera real (`vi.waitFor`)
// avança o relógio por um passo fixo a cada volta, e toda espera real declara um prazo que não é menor que o
// `testTimeout` do projeto (o prazo real é só a guarda; o relógio avançado até a próxima espera é que anda).

// Texto entre os parênteses da chamada que abre em `open` (índice do "("), pulando strings, templates e comentários.
function callBody(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (char === '/' && next === '/') {
      index = source.indexOf('\n', index);
      if (index < 0) break;
    } else if (char === '/' && next === '*') {
      index = source.indexOf('*/', index) + 1;
    } else if (char === "'" || char === '"' || char === '`') {
      index = closingQuote(source, index);
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return source.slice(open + 1);
}

// Índice da aspa que fecha a string aberta em `start`; num template, o `${...}` conta como código e não como texto.
function closingQuote(source: string, start: number): number {
  const quote = source.charAt(start);
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === '\\') index += 1;
    else if (char === quote) return index;
    else if (quote === '`' && char === '$' && source.charAt(index + 1) === '{')
      index = closingBrace(source, index + 1);
  }
  return source.length;
}

function closingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === "'" || char === '"' || char === '`')
      index = closingQuote(source, index);
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

function waitForCalls(source: string): string[] {
  return [...source.matchAll(/\bvi\.waitFor\(/g)].map((match) =>
    callBody(source, match.index + match[0].length - 1),
  );
}

function timeoutMs(call: string): number | undefined {
  const declared = /\btimeout:\s*([\w]+)/.exec(call)?.[1];
  if (declared === undefined) return undefined;
  if (declared === 'WAIT_GUARD_MS') return WAIT_GUARD_MS;
  const literal = Number(declared.replaceAll('_', ''));
  return Number.isNaN(literal) ? undefined : literal;
}

// Uma frase por espera que quebra uma das duas regras.
function waitViolations(source: string): string[] {
  return waitForCalls(source).flatMap((call) => {
    const found: string[] = [];
    const preview = call.replace(/\s+/g, ' ').slice(0, 60);
    if (/\.advance\(/.test(call))
      found.push(
        `avança o relógio por passo fixo dentro da espera: ${preview}`,
      );
    const timeout = timeoutMs(call);
    if (timeout === undefined || timeout < WAIT_GUARD_MS)
      found.push(`prazo real ausente ou menor que 60 s: ${preview}`);
    return found;
  });
}

const billingDir = path.join(repoRoot, 'test', 'integration', 'billing');
const helperFiles = ['async.ts', 'dlq.ts', 'worker.ts'].map((name) =>
  path.join(repoRoot, 'test', 'helpers', name),
);
const testFiles = readdirSync(billingDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join(billingDir, name));

describe('FND-13 as esperas dos testes de faturamento', () => {
  it.each(
    [...testFiles, ...helperFiles].map((file) => [
      path.relative(repoRoot, file),
      file,
    ]),
  )(
    'FND-13 %s não avança o relógio por passo fixo numa espera real e dá a toda espera o prazo do testTimeout',
    (_name, file) => {
      expect(waitViolations(readFileSync(file, 'utf8'))).toEqual([]);
    },
  );

  it('FND-13 o varredor acha as esperas de um arquivo (a precondição dos testes acima)', () => {
    const found = [...testFiles, ...helperFiles].flatMap((file) =>
      waitForCalls(readFileSync(file, 'utf8')),
    );

    expect(found.length).toBeGreaterThan(30);
  });

  it('FND-13 controle negativo: uma espera que avança o relógio 500 ms a cada volta e tem prazo de 20 s reprova nas duas regras', () => {
    const sample = [
      'await vi.waitFor(',
      '  async () => {',
      "    world.clock.advance(500); // ) de comentário e ')' de texto não fecham a chamada",
      "    expect(await status()).toBe('invoiced');",
      '  },',
      '  { timeout: 20_000, interval: 20 },',
      ');',
    ].join('\n');

    expect(waitViolations(sample)).toHaveLength(2);
  });

  it('FND-13 controle negativo: uma espera sem prazo declarado reprova, e uma com WAIT_GUARD_MS e sem avanço passa', () => {
    const without = 'await vi.waitFor(() => expect(1).toBe(1));';
    const guarded = [
      'await vi.waitFor(() => expect(`${1 + 1}`).toBe("2"), {',
      '  timeout: WAIT_GUARD_MS,',
      '});',
    ].join('\n');

    expect(waitViolations(without)).toHaveLength(1);
    expect(waitViolations(guarded)).toEqual([]);
  });
});
