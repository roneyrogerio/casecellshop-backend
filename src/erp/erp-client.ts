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

// A requisição pode não ter chegado ao ERP, ou ele recusou sem processar: repetir é seguro.
// `cause` serve ao log (por exemplo `timeout`, `ECONNREFUSED`, `http_503`), nunca a decisões.
export interface ErpTransient {
  kind: 'transient';
  cause: string;
}

// 400, 401, 403 ou 404 sem o corpo esperado: erro do adaptador ou credencial vencida.
// Transitório para o worker, com alerta, para não falhar todos os pedidos de uma vez.
export interface ErpConfigError {
  kind: 'config_error';
  status: number;
}

export type CreateOrderResult =
  | { kind: 'ok'; order: ErpOrder }
  | { kind: 'permanent'; reason: 'rejected' | 'out_of_stock' }
  | ErpTransient
  // Pode ter chegado sem resposta conclusiva: a próxima tentativa consulta antes de criar.
  | { kind: 'ambiguous'; cause: string }
  | ErpConfigError;

export type FindOrderResult =
  | { kind: 'found'; order: ErpOrder }
  // Só com o sinal explícito do ERP (404 com o corpo de pedido inexistente).
  | { kind: 'not_found' }
  | ErpTransient
  | ErpConfigError;

export type ListCatalogResult =
  { kind: 'ok'; page: ErpCatalogPage } | ErpTransient | ErpConfigError;

// Cada operação devolve um resultado de lista fechada; nenhuma lança por causa do ERP.
export interface ErpClient {
  // Páginas a partir de 1, de tamanho fixo.
  listCatalog(page: number): Promise<ListCatalogResult>;
  // Idempotente pela referência quando a H1b vale.
  createOrder(request: ErpOrderRequest): Promise<CreateOrderResult>;
  // H1a: consulta pela referência externa (o orderId da loja).
  findOrderByReference(reference: string): Promise<FindOrderResult>;
}
