export const DEFAULT_KNOWN_VENDORS = [
  'Fila', 'Dove', 'Elizabeth Arden', 'Tom Ford', 'Yves Saint Laurent', 'DKNY', 'NARS',
  'Guerlain', 'Virbac', 'Green Hill', 'Shock Doctor', 'Adidas', 'Nike', 'Puma',
  'Samsung', 'Apple', 'Sony', 'LG',
];

export const DEFAULT_ALIASES: Record<string, string> = {
  YSL: 'Yves Saint Laurent',
  'Saint Laurent': 'Yves Saint Laurent',
};

export const GENERIC_WORDS = new Set([
  'new','original','premium','size','small','medium','large','women','womens','men','mens','kids','baby',
  'black','white','red','blue','wireless','fashion','classic','professional','universal',
  'for','with','and','the','a','an','of','to','by',
]);

export const QUANTITY_PREFIX_WORDS = new Set([
  'pair','pack','packs','pcs','pc','piece','pieces','set','sets','qty','quantity','size',
]);

export const UNIT_WORDS = new Set([
  'ml','l','g','kg','oz','cm','mm','inch','in','pcs','pc',
]);
