import type { ErpCatalogItem, ErpCatalogPage, ErpOrder } from './erp-client.ts';

// O corpo do ERP é entrada externa: nada dele é confiável antes de passar por aqui.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function bodyCode(body: unknown): unknown {
  return isRecord(body) ? body['code'] : undefined;
}

export function parseOrder(body: unknown): ErpOrder | undefined {
  if (!isRecord(body)) return undefined;
  const { erpOrderId, reference } = body;
  if (typeof erpOrderId !== 'string' || typeof reference !== 'string')
    return undefined;
  return { erpOrderId, reference };
}

function parseCatalogItem(value: unknown): ErpCatalogItem | undefined {
  if (!isRecord(value)) return undefined;
  const { sku, name, priceCents, onHand } = value;
  if (
    typeof sku !== 'string' ||
    typeof name !== 'string' ||
    // Dinheiro em centavos inteiros e estoque nunca negativo: um valor fora disso é contrato quebrado.
    typeof priceCents !== 'number' ||
    typeof onHand !== 'number' ||
    !Number.isSafeInteger(priceCents) ||
    !Number.isSafeInteger(onHand) ||
    priceCents < 0 ||
    onHand < 0
  ) {
    return undefined;
  }
  return { sku, name, priceCents, onHand };
}

// Undefined quando o corpo não é uma página válida do catálogo.
export function parseCatalogPage(body: unknown): ErpCatalogPage | undefined {
  if (
    !isRecord(body) ||
    !Array.isArray(body['items']) ||
    typeof body['hasNext'] !== 'boolean'
  )
    return undefined;
  const items = body['items'].map(parseCatalogItem);
  if (!items.every((item): item is ErpCatalogItem => item !== undefined))
    return undefined;
  return { items, hasNext: body['hasNext'] };
}
