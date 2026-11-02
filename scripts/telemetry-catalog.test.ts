import { describe, expect, it } from 'vitest';
import { repeatedNames } from './telemetry-catalog.ts';

// OBS-07 (AD-029): as declarações de cada pasta são juntadas por spread, e o segundo nome igual apagaria o
// primeiro em silêncio. `repeatedNames` acusa o nome que aparece em mais de uma declaração, ou duas vezes na
// mesma lista (uma métrica e um evento com o mesmo nome também colidem, porque o catálogo é um só).

const HTTP = {
  'http.server.request.duration': {},
  'casecellshop.http.request.completed': {},
};
const BILLING = {
  'casecellshop.outbox.attempts': {},
  'casecellshop.worker.started': {},
};

describe('OBS-07 repeatedNames: nomes repetidos entre as declarações', () => {
  it('OBS-07 partes sem nome em comum não têm repetição', () => {
    expect(repeatedNames([HTTP, BILLING])).toEqual([]);
  });

  it('OBS-07 a lista vazia, e uma parte vazia, não têm repetição', () => {
    expect(repeatedNames([])).toEqual([]);
    expect(repeatedNames([{}, HTTP, {}])).toEqual([]);
  });

  it('OBS-07 o nome que aparece em duas partes é acusado uma vez', () => {
    const other = {
      'casecellshop.outbox.attempts': {},
      'casecellshop.x.y': {},
    };

    expect(repeatedNames([HTTP, BILLING, other])).toEqual([
      'casecellshop.outbox.attempts',
    ]);
  });

  it('OBS-07 o nome que aparece em três partes é acusado uma vez só', () => {
    const part = { 'casecellshop.dup.name': {} };

    expect(repeatedNames([part, HTTP, part, BILLING, part])).toEqual([
      'casecellshop.dup.name',
    ]);
  });

  it('OBS-07 vários nomes repetidos saem todos, em ordem alfabética', () => {
    const first = { 'casecellshop.b.name': {}, 'casecellshop.a.name': {} };
    const second = { 'casecellshop.a.name': {}, 'casecellshop.b.name': {} };

    expect(repeatedNames([first, second])).toEqual([
      'casecellshop.a.name',
      'casecellshop.b.name',
    ]);
  });

  it('OBS-07 uma métrica e um evento com o mesmo nome, na mesma lista de partes, são acusados', () => {
    const metrics = {
      'casecellshop.checkout.accepted': { instrument: 'counter' },
    };
    const events = {
      'casecellshop.checkout.accepted': { levels: ['info'] },
    };

    expect(repeatedNames([metrics, events])).toEqual([
      'casecellshop.checkout.accepted',
    ]);
  });
});
