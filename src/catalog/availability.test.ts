import { describe, expect, it } from 'vitest';
import { availabilityOf } from './availability.ts';

// CAT-13 (design.md, "Vitrine e cache"): a faixa sai das unidades livres, `on_hand − reserved`, e o número exato
// não aparece. O limite das últimas unidades é o `lowStockMax` da configuração (5).

describe('CAT-13 availabilityOf: a faixa pelas unidades livres', () => {
  it.each([
    [-3, 'out_of_stock'],
    [-1, 'out_of_stock'],
    [0, 'out_of_stock'],
    [1, 'low_stock'],
    [4, 'low_stock'],
    [5, 'low_stock'],
    [6, 'available'],
    [7, 'available'],
    [1_000, 'available'],
  ] as const)(
    'CAT-13 %i unidades livres com o limite 5 saem como %s',
    (freeUnits, expected) => {
      expect(availabilityOf(freeUnits, 5)).toBe(expected);
    },
  );

  it.each([
    [0, 'out_of_stock'],
    [1, 'low_stock'],
    [2, 'low_stock'],
    [3, 'available'],
  ] as const)(
    'CAT-13 %i unidades livres com o limite 2 saem como %s: o limite vem do parâmetro, não de um 5 fixo',
    (freeUnits, expected) => {
      expect(availabilityOf(freeUnits, 2)).toBe(expected);
    },
  );
});
