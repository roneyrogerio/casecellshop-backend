import type { Product } from '../contract/index.ts';

// A faixa pelas unidades livres (on_hand − reserved), sem expor o número (design.md, "Vitrine e cache").
export function availabilityOf(
  _freeUnits: number,
  _lowStockMax: number,
): Product['availability'] {
  throw new Error('não implementado');
}
