import type { Product } from '../contract/index.ts';

// A faixa pelas unidades livres (on_hand − reserved), sem expor o número (design.md, "Vitrine e cache").
export function availabilityOf(
  freeUnits: number,
  lowStockMax: number,
): Product['availability'] {
  if (freeUnits <= 0) return 'out_of_stock';
  return freeUnits <= lowStockMax ? 'low_stock' : 'available';
}
