export const products = [
  {id: '16', name: 'НФГ-6,0-02', basePrice: 38600, currency: 'RUB', source: 'demo'},
  {id: '17', name: 'ОГК-6', basePrice: 38600, currency: 'RUB', source: 'demo'},
  {id: '18', name: 'Кронштейн 1.К1-2,0-2,0-Ф2', basePrice: 3740, currency: 'RUB', source: 'demo'},
  {id: '19', name: 'Закладная деталь ЗФ-20/4/К230-2,0', basePrice: 9600, currency: 'RUB', source: 'demo'}
];
export const initialRows = [
  {id: 'row-demo-1', productId: '16', productName: 'НФГ-6,0-02', basePrice: 38600, currency: 'RUB', quantity: '24', coatingCode: 'zinc', ralColor: '', k1: '1,12', k2: '1,08', k3: '1,18', pricePerKg: '120', weight: '', fasteners: '0', executionTerm: '', source: 'demo'},
  {id: 'row-demo-2', productId: '17', productName: 'ОГК-6', basePrice: 38600, currency: 'RUB', quantity: '12', coatingCode: 'paint', ralColor: '', k1: '1,15', k2: '1,05', k3: '1,12', pricePerKg: '130', weight: '', fasteners: '0', executionTerm: '', source: 'demo'}
];
export function newRow(product = products[0]) {
  return {id: crypto.randomUUID(), productId: String(product.id), productName: product.name, basePrice: product.basePrice, currency: product.currency, quantity: '1', coatingCode: 'none', ralColor: '', k1: '1', k2: '1', k3: '1', pricePerKg: '', weight: '', fasteners: '0', executionTerm: '', source: product.source || 'catalog'};
}
