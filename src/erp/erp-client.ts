// Porta do ERP (camada anticorrupção): o resto do sistema só conhece este
// modelo, nunca o do ERP real nem o do simulado.

export interface ErpCatalogItem {
  sku: string;
  name: string;
  priceCents: number;
  onHand: number;
}

export interface ErpCatalogPage {
  items: ErpCatalogItem[];
  hasNext: boolean;
}

export interface ErpOrderItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface ErpOrderRequest {
  reference: string;
  items: ErpOrderItem[];
}

export interface ErpOrder {
  erpOrderId: string;
  reference: string;
}

export interface ErpClient {
  // Páginas a partir de 1, de tamanho fixo.
  listCatalog(page: number): Promise<ErpCatalogPage>;
  // Idempotente pela referência (H1b): repetir devolve a fatura existente.
  createOrder(request: ErpOrderRequest): Promise<ErpOrder>;
  // H1a: null só quando o ERP afirma que a referência não existe.
  findOrderByReference(reference: string): Promise<ErpOrder | null>;
}

// Recusa permanente do ERP: repetir a chamada não muda o resultado (H2 e SKU desconhecido).
export class ErpRejectedError extends Error {
  readonly reason: 'out_of_stock' | 'unknown_product';
  readonly sku: string;

  constructor(reason: 'out_of_stock' | 'unknown_product', sku: string) {
    super(reason === 'out_of_stock' ? `Sem estoque no ERP: ${sku}` : `Produto desconhecido no ERP: ${sku}`);
    this.reason = reason;
    this.sku = sku;
  }
}
