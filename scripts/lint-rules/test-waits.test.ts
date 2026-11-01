import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import plugin from './test-waits.ts';

// FND-13 (Checagem): as regras do plugin test-waits, lidas pela árvore de sintaxe e testadas com o RuleTester do
// oxlint. O nome de cada caso começa pelo ID do critério (AI-38 e AI-18): o RuleTester monta o nome sozinho a
// partir do código, então todo caso leva `name`. Comentário e string não contam; o prazo é lido como expressão.
// A escolha de pastas (test/integration/ e test/helpers/ sim, o resto não) fica em test/repo/integration-waits.test.ts,
// que lê o .oxlintrc.json do projeto.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'ts' }, sourceType: 'module' },
});

function ok(label: string, code: string): RuleTester.ValidTestCase {
  return { code, name: `FND-13 passa ${label}` };
}

function bad(
  label: string,
  code: string,
  errors = 1,
): RuleTester.InvalidTestCase {
  return { code, errors, name: `FND-13 reprova ${label}` };
}

// ---------------------------------------------------------------- no-fixed-step

ruleTester.run('no-fixed-step', plugin.rules['no-fixed-step'], {
  valid: [
    ok(
      'uma espera que só confere, sem avançar o relógio',
      'await vi.waitFor(() => expect(status).toBe(1), { timeout: WAIT_GUARD_MS });',
    ),
    ok(
      'um laço de teste que avança o relógio fora de uma espera (o controle negativo do worker-clock)',
      [
        'for (let step = 0; step < 100; step += 1) {',
        '  world.clock.advance(500);',
        '  await settle();',
        '}',
      ].join('\n'),
    ),
    ok(
      'um avanço depois da espera, e não dentro dela',
      [
        'await vi.waitFor(() => expect(status).toBe(1), { timeout: WAIT_GUARD_MS });',
        'world.clock.advance(500);',
      ].join('\n'),
    ),
    ok(
      'um avanço antes da espera, e não dentro dela',
      [
        'world.clock.advance(500);',
        'await vi.waitFor(() => expect(status).toBe(1), { timeout: WAIT_GUARD_MS });',
      ].join('\n'),
    ),
    ok(
      '.advance citado só em comentário dentro da espera',
      [
        'await vi.waitFor(',
        '  () => {',
        '    // antes: world.clock.advance(500) a cada volta',
        '    expect(status).toBe(1);',
        '  },',
        '  { timeout: WAIT_GUARD_MS },',
        ');',
      ].join('\n'),
    ),
    ok(
      '.advance(500) citado só em string e em template dentro da espera',
      [
        'await vi.waitFor(',
        '  () => {',
        "    expect(text).toBe('world.clock.advance(500)');",
        '    expect(other).toBe(`clock.advance(${step})`);',
        '  },',
        '  { timeout: WAIT_GUARD_MS },',
        ');',
      ].join('\n'),
    ),
    ok(
      'um advance() que é identificador solto (o parâmetro dentro do helper)',
      [
        'export function waitAdvancing(advance, check) {',
        '  return vi.waitFor(',
        '    async () => {',
        '      try {',
        '        await check();',
        '      } catch (error) {',
        '        advance();',
        '        throw error;',
        '      }',
        '    },',
        '    { timeout: WAIT_GUARD_MS, interval: 20 },',
        '  );',
        '}',
      ].join('\n'),
    ),
    ok(
      'waitAdvancing com o advanceIdle do mundo como referência',
      'await waitAdvancing(world.advanceIdle, () => expect(status).toBe(1));',
    ),
    ok(
      'waitAdvancing com o advanceToNext do relógio como referência',
      'await waitAdvancing(clock.advanceToNext, () => expect(status).toBe(1));',
    ),
    ok(
      'waitAdvancing com o advanceIdle como identificador solto',
      'await waitAdvancing(advanceIdle, () => expect(status).toBe(1));',
    ),
    ok(
      'waitAdvancing com o advanceToNext como identificador solto',
      'await waitAdvancing(advanceToNext, () => expect(status).toBe(1));',
    ),
    ok(
      'waitAdvancing com uma função que só chama o advanceIdle',
      'await waitAdvancing(() => world.advanceIdle(), () => expect(status).toBe(1));',
    ),
    ok(
      'waitAdvancing com uma função que só chama o advanceToNext',
      'await waitAdvancing(() => clock.advanceToNext(), async () => { expect(await read()).toBe(1); });',
    ),
    ok(
      'waitAdvancing com uma função que só chama o advanceIdle como identificador',
      'await waitAdvancing(() => advanceIdle(), () => expect(status).toBe(1));',
    ),
    ok(
      'waitAdvancing com corpo entre chaves de uma só instrução que chama o advanceIdle',
      'await waitAdvancing(() => { world.advanceIdle(); }, () => expect(status).toBe(1));',
    ),
    ok(
      'um vi.waitFor citado só em comentário',
      '// vi.waitFor(() => clock.advance(500), { timeout: 20_000 });\nconst x = 1;',
    ),
    ok(
      'um waitAdvancing citado só em string',
      "const text = 'waitAdvancing(() => clock.advance(500), check)';",
    ),
    ok(
      'um vi.waitUntil que só confere, sem avançar o relógio',
      'await vi.waitUntil(() => status === 1, { timeout: WAIT_GUARD_MS });',
    ),
    ok(
      'um expect.poll que só confere, sem avançar o relógio',
      'await expect.poll(() => status, { timeout: WAIT_GUARD_MS }).toBe(1);',
    ),
    ok(
      'um avanço depois do vi.waitUntil, e não dentro dele',
      [
        'await vi.waitUntil(() => status === 1, { timeout: WAIT_GUARD_MS });',
        'world.clock.advance(500);',
      ].join('\n'),
    ),
  ],
  invalid: [
    bad(
      'um .advance(…) dentro do vi.waitUntil',
      'await vi.waitUntil(() => { clock.advance(500); return status === 1; }, { timeout: WAIT_GUARD_MS });',
    ),
    bad(
      'um .advance(…) dentro do vi.waitUntil sem segundo argumento',
      'await vi.waitUntil(() => { world.clock.advance(500); return true; });',
    ),
    bad(
      'um .advance(…) dentro do expect.poll',
      'await expect.poll(() => { clock.advance(500); return status; }, { timeout: WAIT_GUARD_MS }).toBe(1);',
    ),
    bad(
      'um .advance(…) dentro do expect.poll sem segundo argumento',
      'await expect.poll(async () => { world.clock.advance(500); return await read(); }).toBe(1);',
    ),
    bad(
      'um .advance(500) dentro do vi.waitFor',
      [
        'await vi.waitFor(',
        '  async () => {',
        '    world.clock.advance(500);',
        "    expect(await status()).toBe('invoiced');",
        '  },',
        '  { timeout: WAIT_GUARD_MS, interval: 20 },',
        ');',
      ].join('\n'),
    ),
    bad(
      'um .advance(…) com o relógio direto, sem o mundo, dentro do vi.waitFor',
      'await vi.waitFor(() => { clock.advance(1_000); expect(1).toBe(1); }, { timeout: WAIT_GUARD_MS });',
    ),
    bad(
      'um .advance(…) numa expressão de seta do vi.waitFor',
      'await vi.waitFor(() => expect(world.clock.advance(500)).toBeUndefined(), { timeout: WAIT_GUARD_MS });',
    ),
    bad(
      'um .advance(…) fundo, dentro de um if e de um laço, dentro do vi.waitFor',
      [
        'await vi.waitFor(',
        '  async () => {',
        '    if (await pending()) {',
        '      for (const step of steps) {',
        '        clock.advance(step);',
        '      }',
        '    }',
        '  },',
        '  { timeout: WAIT_GUARD_MS },',
        ');',
      ].join('\n'),
    ),
    bad(
      'um .advance(…) depois de um await dentro do vi.waitFor',
      [
        'await vi.waitFor(async () => {',
        '  await settle();',
        '  world.clock.advance(500);',
        '}, { timeout: WAIT_GUARD_MS });',
      ].join('\n'),
    ),
    bad(
      'um .advance(…) no corpo de um catch dentro do vi.waitFor',
      [
        'await vi.waitFor(async () => {',
        '  try {',
        '    await check();',
        '  } catch (error) {',
        '    world.clock.advance(500);',
        '    throw error;',
        '  }',
        '}, { timeout: WAIT_GUARD_MS });',
      ].join('\n'),
    ),
    bad(
      'dois .advance(…) na mesma espera, um erro por chamada',
      'await vi.waitFor(() => { clock.advance(1); clock.advance(2); }, { timeout: WAIT_GUARD_MS });',
      2,
    ),
    bad(
      'um .advance(…) dentro do vi.waitFor sem segundo argumento',
      'await vi.waitFor(() => { clock.advance(500); });',
    ),
    bad(
      'um .advance(…) no segundo argumento do waitAdvancing (a conferência)',
      'await waitAdvancing(world.advanceIdle, () => { world.clock.advance(500); });',
    ),
    bad(
      'um .advance(…) numa conferência async do waitAdvancing',
      'await waitAdvancing(clock.advanceToNext, async () => { clock.advance(1); expect(await read()).toBe(1); });',
    ),
    bad(
      'um .advance(500) no primeiro argumento do waitAdvancing: o .advance e o argumento fora do permitido, 2 erros',
      'await waitAdvancing(() => world.clock.advance(500), () => expect(status).toBe(1));',
      2,
    ),
    bad(
      'um waitAdvancing cujo primeiro argumento tem corpo entre chaves com duas instruções',
      'await waitAdvancing(() => { world.advanceIdle(); step(); }, () => expect(status).toBe(1));',
    ),
    bad(
      'um waitAdvancing cujo primeiro argumento é uma função qualquer',
      'await waitAdvancing(() => step(), () => expect(status).toBe(1));',
    ),
    bad(
      'um waitAdvancing cujo primeiro argumento é um identificador qualquer',
      'await waitAdvancing(stepClock, () => expect(status).toBe(1));',
    ),
    bad(
      'um waitAdvancing cujo primeiro argumento é um membro qualquer',
      'await waitAdvancing(world.tick, () => expect(status).toBe(1));',
    ),
    bad(
      'um waitAdvancing cujo primeiro argumento é uma função que chama outra coisa além do advanceIdle',
      'await waitAdvancing(() => world.advanceIdle() && step(), () => expect(status).toBe(1));',
    ),
  ],
});

// ---------------------------------------------------------------- wait-guard

ruleTester.run('wait-guard', plugin.rules['wait-guard'], {
  valid: [
    ok(
      'timeout: WAIT_GUARD_MS',
      'await vi.waitFor(() => expect(1).toBe(1), { timeout: WAIT_GUARD_MS });',
    ),
    ok(
      'timeout: WAIT_GUARD_MS com interval depois',
      'await vi.waitFor(check, { timeout: WAIT_GUARD_MS, interval: 50 });',
    ),
    ok(
      'timeout: WAIT_GUARD_MS com interval antes',
      'await vi.waitFor(check, { interval: 50, timeout: WAIT_GUARD_MS });',
    ),
    ok(
      'timeout: 2 * WAIT_GUARD_MS',
      'await vi.waitFor(check, { timeout: 2 * WAIT_GUARD_MS, interval: 500 });',
    ),
    ok(
      'timeout: WAIT_GUARD_MS * 2',
      'await vi.waitFor(check, { timeout: WAIT_GUARD_MS * 2 });',
    ),
    ok(
      'o vi.waitFor em várias linhas com a conferência async',
      [
        'await vi.waitFor(',
        '  async () => {',
        '    const observed = await getJson(url);',
        '    expect(observed.status).toBe(200);',
        '  },',
        '  { timeout: WAIT_GUARD_MS, interval: 500 },',
        ');',
      ].join('\n'),
    ),
    ok(
      'o vi.waitFor com um template na conferência e o prazo certo',
      'await vi.waitFor(() => expect(`${1 + 1}`).toBe("2"), { timeout: WAIT_GUARD_MS });',
    ),
    ok(
      'um timeout vindo de um parâmetro desestruturado cujo padrão é WAIT_GUARD_MS',
      'async function stop({ graceMs = WAIT_GUARD_MS } = {}) { await vi.waitFor(check, { timeout: graceMs }); }',
    ),
    ok(
      'um timeout vindo de um parâmetro cujo padrão contém WAIT_GUARD_MS',
      'async function f(limit = 2 * WAIT_GUARD_MS) { await vi.waitFor(check, { timeout: limit }); }',
    ),
    ok(
      'um prazo de observe vindo de um parâmetro cujo padrão é WAIT_GUARD_MS',
      'async function f(guardMs = WAIT_GUARD_MS) { return observe(round, guardMs); }',
    ),
    ok(
      'observe com WAIT_GUARD_MS',
      'const outcome = await observe(round, WAIT_GUARD_MS);',
    ),
    ok(
      'observe com 2 * WAIT_GUARD_MS',
      'const outcome = await observe(queue.send([message]), 2 * WAIT_GUARD_MS);',
    ),
    ok(
      'um vi.waitFor citado só em comentário, sem prazo',
      '// vi.waitFor(check, { timeout: 20_000 });\nconst x = 1;',
    ),
    ok(
      'um vi.waitFor citado só em string, sem prazo',
      "const text = 'vi.waitFor(check)';",
    ),
    ok(
      'a declaração de observe, que não é uma chamada',
      [
        'export async function observe(promise, guardMs) {',
        '  const startedAt = performance.now();',
        '  return { startedAt, promise, guardMs };',
        '}',
      ].join('\n'),
    ),
    ok(
      'outra função que só começa com observe (observeQueue)',
      'const observed = observeQueue(inner);',
    ),
    ok(
      'uma chamada sem relação, com timeout literal',
      'await container.stop({ timeout: 10_000 });',
    ),
    ok(
      'timeout: WAIT_GUARD_MS * 3 (produto por um literal maior que 1)',
      'await vi.waitFor(check, { timeout: WAIT_GUARD_MS * 3 });',
    ),
    ok(
      'um vi.waitUntil com timeout: WAIT_GUARD_MS',
      'await vi.waitUntil(() => status === 1, { timeout: WAIT_GUARD_MS });',
    ),
    ok(
      'um vi.waitUntil com timeout: 2 * WAIT_GUARD_MS e interval',
      'await vi.waitUntil(check, { timeout: 2 * WAIT_GUARD_MS, interval: 50 });',
    ),
    ok(
      'um expect.poll com timeout: WAIT_GUARD_MS no segundo argumento',
      'await expect.poll(() => status, { timeout: WAIT_GUARD_MS }).toBe(1);',
    ),
    ok(
      'um expect.poll com timeout: WAIT_GUARD_MS * 2 e interval',
      'await expect.poll(read, { timeout: WAIT_GUARD_MS * 2, interval: 20 }).toBe(1);',
    ),
    ok(
      'um expect.poll vindo de um parâmetro cujo padrão é WAIT_GUARD_MS',
      'async function f(limit = WAIT_GUARD_MS) { await expect.poll(read, { timeout: limit }).toBe(1); }',
    ),
  ],
  invalid: [
    bad(
      'um timeout de WAIT_GUARD_MS / 10 (a divisão encurta o prazo)',
      'await vi.waitFor(check, { timeout: WAIT_GUARD_MS / 10 });',
    ),
    bad(
      'um timeout de Math.min(WAIT_GUARD_MS, 1000) (o mínimo encurta o prazo)',
      'await vi.waitFor(check, { timeout: Math.min(WAIT_GUARD_MS, 1000) });',
    ),
    bad(
      'um timeout de WAIT_GUARD_MS - 59_000 (a subtração encurta o prazo)',
      'await vi.waitFor(check, { timeout: WAIT_GUARD_MS - 59_000 });',
    ),
    bad(
      'um timeout de WAIT_GUARD_MS * 0.5 (o literal é menor que 1)',
      'await vi.waitFor(check, { timeout: WAIT_GUARD_MS * 0.5 });',
    ),
    bad(
      'um timeout de WAIT_GUARD_MS * graceMs (o fator não é literal)',
      'await vi.waitFor(check, { timeout: WAIT_GUARD_MS * graceMs });',
    ),
    bad(
      'um timeout de WAIT_GUARD_MS + 1 (a soma não é produto)',
      'await vi.waitFor(check, { timeout: WAIT_GUARD_MS + 1 });',
    ),
    bad(
      'um timeout vindo de um parâmetro cujo padrão é WAIT_GUARD_MS / 10',
      'async function f(limit = WAIT_GUARD_MS / 10) { await vi.waitFor(check, { timeout: limit }); }',
    ),
    bad(
      'um observe com prazo de WAIT_GUARD_MS / 10',
      'const outcome = await observe(round, WAIT_GUARD_MS / 10);',
    ),
    bad(
      'um observe com prazo de Math.min(WAIT_GUARD_MS, 1000)',
      'const outcome = await observe(round, Math.min(WAIT_GUARD_MS, 1000));',
    ),
    bad(
      'um observe com prazo de WAIT_GUARD_MS - 59_000',
      'const outcome = await observe(p, WAIT_GUARD_MS - 59_000);',
    ),
    bad(
      'um vi.waitUntil sem segundo argumento (o padrão do Vitest é 1 s)',
      'await vi.waitUntil(() => status === 1);',
    ),
    bad(
      'um vi.waitUntil com opções sem timeout',
      'await vi.waitUntil(check, { interval: 50 });',
    ),
    bad(
      'um vi.waitUntil com timeout literal',
      'await vi.waitUntil(check, { timeout: 5_000 });',
    ),
    bad(
      'um vi.waitUntil com timeout de WAIT_GUARD_MS / 10',
      'await vi.waitUntil(check, { timeout: WAIT_GUARD_MS / 10 });',
    ),
    bad(
      'um expect.poll sem segundo argumento (o padrão do Vitest é 1 s)',
      'await expect.poll(() => status).toBe(1);',
    ),
    bad(
      'um expect.poll com opções sem timeout',
      'await expect.poll(read, { interval: 50 }).toBe(1);',
    ),
    bad(
      'um expect.poll com timeout literal',
      'await expect.poll(read, { timeout: 5_000 }).toBe(1);',
    ),
    bad(
      'um expect.poll com timeout de Math.min(WAIT_GUARD_MS, 1000)',
      'await expect.poll(read, { timeout: Math.min(WAIT_GUARD_MS, 1000) }).toBe(1);',
    ),
    bad(
      'um vi.waitFor sem segundo argumento',
      'await vi.waitFor(() => expect(1).toBe(1));',
    ),
    bad(
      'um vi.waitFor com opções sem timeout',
      'await vi.waitFor(check, { interval: 50 });',
    ),
    bad('um vi.waitFor com opções vazias', 'await vi.waitFor(check, {});'),
    bad(
      'um timeout literal de 20_000',
      'await vi.waitFor(check, { timeout: 20_000, interval: 20 });',
    ),
    bad(
      'um timeout literal de 120_000, maior que o testTimeout mas fora do WAIT_GUARD_MS',
      'await vi.waitFor(check, { timeout: 120_000, interval: 500 });',
    ),
    bad(
      'um timeout literal de 60_000, igual ao valor mas sem citar o WAIT_GUARD_MS',
      'await vi.waitFor(check, { timeout: 60_000 });',
    ),
    bad(
      'um timeout vindo de um parâmetro desestruturado cujo padrão é 1_000',
      'async function stop({ graceMs = 1_000 } = {}) { await vi.waitFor(check, { timeout: graceMs }); }',
    ),
    bad(
      'um timeout vindo de um parâmetro cujo padrão é 1_000',
      'async function f(limit = 1_000) { await vi.waitFor(check, { timeout: limit }); }',
    ),
    bad(
      'um timeout vindo de um parâmetro sem padrão',
      'async function f(limit) { await vi.waitFor(check, { timeout: limit }); }',
    ),
    bad(
      'um prazo de observe vindo de um parâmetro cujo padrão é 1_000',
      'async function f(guardMs = 1_000) { return observe(round, guardMs); }',
    ),
    bad(
      'um timeout que é uma variável qualquer',
      'await vi.waitFor(check, { timeout: limit });',
    ),
    bad(
      'um timeout em forma abreviada ({ timeout })',
      'await vi.waitFor(check, { timeout });',
    ),
    bad(
      'um timeout que é uma expressão sem o WAIT_GUARD_MS',
      'await vi.waitFor(check, { timeout: 2 * graceMs });',
    ),
    bad(
      'um timeout que cita WAIT_GUARD_MS só em comentário',
      'await vi.waitFor(check, { timeout: 5_000 /* WAIT_GUARD_MS */ });',
    ),
    bad(
      'um timeout que cita WAIT_GUARD_MS só em string',
      "await vi.waitFor(check, { timeout: 'WAIT_GUARD_MS' });",
    ),
    bad(
      'um WAIT_GUARD_MS em outra propriedade que não é o timeout',
      'await vi.waitFor(check, { interval: WAIT_GUARD_MS });',
    ),
    bad(
      'um vi.waitFor com a conferência em várias linhas e timeout literal',
      [
        'await vi.waitFor(',
        '  async () => {',
        '    expect(await read()).toBe(1);',
        '  },',
        '  { timeout: 90_000, interval: 500 },',
        ');',
      ].join('\n'),
    ),
    bad(
      'dois vi.waitFor sem prazo, um erro por espera',
      [
        'await vi.waitFor(() => expect(1).toBe(1));',
        'await vi.waitFor(() => expect(2).toBe(2), { timeout: 5_000 });',
      ].join('\n'),
      2,
    ),
    bad(
      'um observe sem segundo argumento',
      'const outcome = await observe(round);',
    ),
    bad(
      'um observe com prazo literal',
      'const outcome = await observe(queue.send([message]), 12_000);',
    ),
    bad(
      'um observe com prazo numa variável qualquer',
      'const outcome = await observe(round, guardMs);',
    ),
    bad(
      'um observe com prazo que cita WAIT_GUARD_MS só em comentário',
      'const outcome = await observe(round, 12_000 /* WAIT_GUARD_MS */);',
    ),
  ],
});

// ---------------------------------------------------------------- no-port-before-up

// O gatilho é o arquivo chamar upComposeProject(…): as amostras inválidas e as válidas com compose levam a chamada.
const UP = "const environment = await upComposeProject('p', 'logs', collect);";

ruleTester.run('no-port-before-up', plugin.rules['no-port-before-up'], {
  valid: [
    ok(
      'server.listen(0) num arquivo sem compose (o servidor local de teste)',
      [
        "import { createServer } from 'node:http';",
        'const server = createServer();',
        "await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));",
      ].join('\n'),
    ),
    ok(
      'um import de valor do node:net num arquivo sem compose',
      "import { createServer } from 'node:net';\nconst server = createServer();",
    ),
    ok(
      'um freePort num arquivo sem compose',
      'async function freePort(): Promise<number> { return 1; }\nconst port = await freePort();',
    ),
    ok(
      'o import type do node:net num arquivo com compose',
      ["import type { Socket } from 'node:net';", UP].join('\n'),
    ),
    ok(
      'a porta publicada lida depois do up',
      [UP, "const apiPort = publishedPort(environment, 'api-1', 3000);"].join(
        '\n',
      ),
    ),
    ok(
      'listen(0) e freePort citados só em comentário, num arquivo com compose',
      [
        '// o antigo freePort fazia listen(0) e fechava o servidor',
        '/* server.listen(0) */',
        UP,
      ].join('\n'),
    ),
    ok(
      'freePort e listen(0) citados só em string, num arquivo com compose',
      [
        UP,
        "const text = 'freePort() e server.listen(0)';",
        'const other = `listen(0) ${1}`;',
      ].join('\n'),
    ),
    ok(
      'um listen numa porta que não é a 0, num arquivo com compose',
      [UP, 'server.listen(3000);'].join('\n'),
    ),
    ok(
      'o import do node:http num arquivo com compose',
      ["import { createServer } from 'node:http';", UP].join('\n'),
    ),
    ok(
      'um listen({ port: 3000 }) (forma de objeto, porta fixa), num arquivo com compose',
      [UP, 'server.listen({ port: 3000 });'].join('\n'),
    ),
    ok(
      'um server.listen() sem argumento num arquivo sem compose',
      'server.listen();',
    ),
    ok(
      'um listen({ port: 0 }) num arquivo sem compose',
      'server.listen({ port: 0 });',
    ),
    ok(
      'o upComposeProject só importado, sem chamada, com listen(0) (não sobe o compose)',
      [
        "import { upComposeProject } from '../../helpers/compose.ts';",
        'server.listen(0);',
      ].join('\n'),
    ),
    // A16: porta fixa é um número literal maior que 0, como primeiro argumento ou como `port` de um objeto.
    ok(
      'um listen(8080) com porta fixa, num arquivo com compose',
      [UP, 'server.listen(8080);'].join('\n'),
    ),
    ok(
      "um listen(8080, '127.0.0.1') com porta fixa e host, num arquivo com compose",
      [UP, "server.listen(8080, '127.0.0.1');"].join('\n'),
    ),
    ok(
      'um listen(8080, host, callback) com porta fixa, num arquivo com compose',
      [UP, "server.listen(8080, '127.0.0.1', resolve);"].join('\n'),
    ),
    ok(
      "um listen({ port: 8080, host: '127.0.0.1' }) com porta fixa e host, num arquivo com compose",
      [UP, "server.listen({ port: 8080, host: '127.0.0.1' });"].join('\n'),
    ),
    ok(
      'um listen({ host, port: 8080 }) com a porta depois do host, num arquivo com compose',
      [UP, "server.listen({ host: '127.0.0.1', port: 8080 }, resolve);"].join(
        '\n',
      ),
    ),
    ok(
      'um listen(handler) num arquivo sem compose (controle: a regra só vale com o compose)',
      'server.listen(handler);',
    ),
    ok(
      'um listen({ host }) sem port num arquivo sem compose (controle)',
      "server.listen({ host: '127.0.0.1' });",
    ),
    ok(
      'um listen(port) numa variável num arquivo sem compose (controle)',
      'server.listen(port);',
    ),
    ok(
      'um listen(0) e um listen(undefined) num arquivo sem compose (controle)',
      'server.listen(0);\nserver.listen(undefined);',
    ),
  ],
  invalid: [
    // A16: qualquer forma que não seja porta fixa literal escolhe a porta antes do up.
    bad(
      'um listen(() => {}) com função no lugar da porta, num arquivo com compose',
      [UP, 'server.listen(() => {});'].join('\n'),
    ),
    bad(
      'um listen(function () {}) com função anônima, num arquivo com compose',
      [UP, 'server.listen(function () {});'].join('\n'),
    ),
    bad(
      'um listen(handler) com função por referência, num arquivo com compose',
      [UP, 'server.listen(handler);'].join('\n'),
    ),
    bad(
      "um listen({ host: '127.0.0.1' }) com objeto sem port, num arquivo com compose",
      [UP, "server.listen({ host: '127.0.0.1' });"].join('\n'),
    ),
    bad(
      'um listen({}) com objeto vazio, num arquivo com compose',
      [UP, 'server.listen({});'].join('\n'),
    ),
    bad(
      'um listen(undefined), num arquivo com compose',
      [UP, 'server.listen(undefined);'].join('\n'),
    ),
    bad(
      'um listen({ port: undefined }), num arquivo com compose',
      [UP, 'server.listen({ port: undefined });'].join('\n'),
    ),
    bad(
      'um listen(port) com variável, num arquivo com compose',
      [UP, 'const port = 0;', 'server.listen(port);'].join('\n'),
    ),
    bad(
      'um listen({ port }) com variável abreviada, num arquivo com compose',
      [UP, 'const port = 0;', 'server.listen({ port });'].join('\n'),
    ),
    bad(
      'um listen({ port: p }) com variável, num arquivo com compose',
      [UP, 'const p = 0;', 'server.listen({ port: p });'].join('\n'),
    ),
    bad(
      "um listen('8080') com texto no lugar da porta, num arquivo com compose",
      [UP, "server.listen('8080');"].join('\n'),
    ),
    bad(
      'um listen(-1) com número negativo, num arquivo com compose',
      [UP, 'server.listen(-1);'].join('\n'),
    ),
    bad(
      'um listen({ port: -1 }) com número negativo, num arquivo com compose',
      [UP, 'server.listen({ port: -1 });'].join('\n'),
    ),
    bad(
      'um listen(handler, 8080) com a porta fora da primeira posição, num arquivo com compose',
      [UP, 'server.listen(handler, 8080);'].join('\n'),
    ),
    bad(
      'um listen(() => {}) antes da chamada do upComposeProject',
      ['server.listen(() => {});', UP].join('\n'),
    ),
    bad(
      'um freePort declarado, num arquivo com compose',
      [
        'async function freePort(): Promise<number> {',
        '  return 1;',
        '}',
        UP,
      ].join('\n'),
    ),
    bad(
      'um freePort usado, num arquivo com compose',
      ['const port = await freePort();', UP].join('\n'),
    ),
    bad(
      'um freePort usado antes da chamada do upComposeProject, e declarado em outro lugar',
      [
        "const environment = await upComposeProject('p', 'logs', collect);",
        'const port = await freePort();',
      ].join('\n'),
    ),
    bad(
      'um freePort declarado como constante, num arquivo com compose',
      ['const freePort = () => 1;', UP].join('\n'),
    ),
    bad(
      'um server.listen(0, …), num arquivo com compose',
      [UP, "server.listen(0, '127.0.0.1', () => server.close());"].join('\n'),
    ),
    bad(
      'um listen(0) sem host, num arquivo com compose',
      [UP, 'server.listen(0);'].join('\n'),
    ),
    bad(
      'um listen(0) encadeado ao createServer, num arquivo com compose',
      [UP, 'createServer().listen(0, resolve);'].join('\n'),
    ),
    bad(
      'um server.listen() sem argumento (o sistema escolhe a porta), num arquivo com compose',
      [UP, 'server.listen();'].join('\n'),
    ),
    bad(
      'um server.listen({ port: 0 }) (forma de objeto), num arquivo com compose',
      [UP, 'server.listen({ port: 0 });'].join('\n'),
    ),
    bad(
      'um server.listen({ port: 0, host }, …) com host e função, num arquivo com compose',
      [UP, "server.listen({ port: 0, host: '127.0.0.1' }, resolve);"].join(
        '\n',
      ),
    ),
    bad(
      'um listen(0) antes da chamada do upComposeProject',
      ['server.listen(0);', UP].join('\n'),
    ),
    bad(
      'um import nomeado de valor do node:net, num arquivo com compose',
      ["import { createServer } from 'node:net';", UP].join('\n'),
    ),
    bad(
      'um import padrão do node:net, num arquivo com compose',
      ["import net from 'node:net';", UP].join('\n'),
    ),
    bad(
      'um import de namespace do node:net, num arquivo com compose',
      ["import * as net from 'node:net';", UP].join('\n'),
    ),
    bad(
      'a cópia do antigo freePort inteiro: o import, a declaração e o listen(0)',
      [
        "import { createServer } from 'node:net';",
        'async function freePort(): Promise<number> {',
        '  const server = createServer();',
        "  server.listen(0, '127.0.0.1', () => server.close());",
        '  return 1;',
        '}',
        UP,
      ].join('\n'),
      3,
    ),
  ],
});
