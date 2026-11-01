// O Prettier, o knip e o jscpd leem configuração de chaves do package.json: qualquer chave fora dos blocos
// de dependências é do oráculo (AI-03, AI-05). Cada item é [nome da chave, objeto a acrescentar ao package.json].
export const CONFIG_KEYS_OUTSIDE_DEPENDENCIES: [
  string,
  Record<string, unknown>,
][] = [
  ['prettier', { prettier: { semi: false } }],
  ['knip', { knip: { ignore: ['src/**'] } }],
  ['jscpd', { jscpd: { threshold: 100 } }],
  ['engines', { engines: { node: '>=1' } }],
];
