// Catalogue produit et règles de configuration.
// Les données viennent de catalog.json : un back-office ou une API pourrait fournir le même format
// sans toucher au rendu 3D ni à l'interface.

export interface Choice {
  id: string;
  name: string;
  price: number;
  hex?: string;
  trims?: string[]; // versions sur lesquelles le choix est proposé (toutes si absent)
}

export interface Trim extends Choice {
  tagline: string;
  specs: { autonomie: string; zeroCent: string; puissance: string };
  accent: 'body' | 'gloss-black' | 'graphite';
  includes?: string[];
}

export interface Paint extends Choice {
  hex: string;
  finish: string;
  metalness: number;
  roughness: number;
  clearcoat: number;
  iridescence: number;
  flakes: number;
}

export interface Wheel extends Choice {
  hex: string;
  metalness: number;
  roughness: number;
}

export interface Option extends Choice {
  visual?: boolean;
  excludes?: string[];
}

export interface Catalog {
  brand: string;
  model: string;
  currency: string;
  basePrice: number;
  financing: { months: number; deposit: number; rate: number; residual: number };
  trims: Trim[];
  paints: Paint[];
  wheels: Wheel[];
  calipers: Choice[];
  interiors: Choice[];
  options: Option[];
}

export interface Config {
  trim: string;
  paint: string;
  wheels: string;
  calipers: string;
  interior: string;
  options: string[];
}

export type SingleKey = Exclude<keyof Config, 'options'>;

export async function loadCatalog(url = 'catalog.json'): Promise<Catalog> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Catalogue indisponible (${res.status})`);
  return res.json();
}

export const listFor = (catalog: Catalog, key: SingleKey): Choice[] =>
  ({ trim: catalog.trims, paint: catalog.paints, wheels: catalog.wheels, calipers: catalog.calipers, interior: catalog.interiors })[key];

export const find = <T extends Choice>(list: T[], id: string): T => list.find((c) => c.id === id) ?? list[0];

export const availableOn = (choice: Choice, trim: string) => !choice.trims || choice.trims.includes(trim);

export const includedIn = (catalog: Catalog, optionId: string, trim: string) =>
  !!find(catalog.trims, trim).includes?.includes(optionId);

export function defaultConfig(catalog: Catalog): Config {
  return {
    trim: catalog.trims[0].id,
    paint: catalog.paints[0].id,
    wheels: catalog.wheels[0].id,
    calipers: catalog.calipers[0].id,
    interior: catalog.interiors[0].id,
    options: [],
  };
}

const LABELS: Record<SingleKey, string> = {
  trim: 'version',
  paint: 'teinte',
  wheels: 'jantes',
  calipers: 'étriers',
  interior: 'intérieur',
};

// Rend une configuration valide et explique chaque correction à l'utilisateur.
export function normalize(catalog: Catalog, input: Config): { config: Config; notices: string[] } {
  const notices: string[] = [];
  const config: Config = { ...input, options: [...input.options] };
  const trim = find(catalog.trims, config.trim);
  config.trim = trim.id;

  for (const key of ['paint', 'wheels', 'calipers', 'interior'] as const) {
    const list = listFor(catalog, key);
    const current = list.find((c) => c.id === config[key]);
    if (current && availableOn(current, trim.id)) continue;
    const fallback = list.find((c) => availableOn(c, trim.id))!;
    if (current) notices.push(`${current.name} n'existe pas en ${trim.name} : ${LABELS[key]} remplacée par ${fallback.name}.`);
    config[key] = fallback.id;
  }

  const kept: string[] = [];
  for (const id of config.options) {
    const option = catalog.options.find((o) => o.id === id);
    if (!option || kept.includes(id)) continue;
    if (!availableOn(option, trim.id)) {
      notices.push(`${option.name} n'existe pas en ${trim.name} : option retirée.`);
      continue;
    }
    if (includedIn(catalog, id, trim.id)) continue; // déjà de série, on ne la facture pas deux fois
    kept.push(id);
  }
  // exclusions : les options sont rangées dans l'ordre du choix, la plus récente l'emporte
  const accepted: Option[] = [];
  for (const id of [...kept].reverse()) {
    const option = find(catalog.options, id);
    const clash = accepted.find((a) => a.excludes?.includes(option.id) || option.excludes?.includes(a.id));
    if (clash) notices.push(`${clash.name} est incompatible avec ${option.name} : ${option.name} a été retirée.`);
    else accepted.unshift(option);
  }
  config.options = accepted.map((o) => o.id);
  return { config, notices };
}

export const hasOption = (catalog: Catalog, config: Config, id: string) =>
  config.options.includes(id) || includedIn(catalog, id, config.trim);

export interface PriceLine {
  label: string;
  detail: string;
  price: number;
  included?: boolean;
}

export function priceLines(catalog: Catalog, config: Config): PriceLine[] {
  const trim = find(catalog.trims, config.trim);
  const paint = find(catalog.paints, config.paint);
  const lines: PriceLine[] = [
    { label: `${catalog.brand} ${catalog.model}`, detail: trim.name, price: catalog.basePrice + trim.price },
    { label: 'Teinte', detail: `${paint.name}, ${paint.finish.toLowerCase()}`, price: paint.price },
    { label: 'Jantes', detail: find(catalog.wheels, config.wheels).name, price: find(catalog.wheels, config.wheels).price },
    { label: 'Étriers', detail: find(catalog.calipers, config.calipers).name, price: find(catalog.calipers, config.calipers).price },
    { label: 'Intérieur', detail: find(catalog.interiors, config.interior).name, price: find(catalog.interiors, config.interior).price },
  ];
  for (const option of catalog.options) {
    if (includedIn(catalog, option.id, config.trim)) lines.push({ label: 'Option', detail: option.name, price: 0, included: true });
    else if (config.options.includes(option.id)) lines.push({ label: 'Option', detail: option.name, price: option.price });
  }
  return lines;
}

export const totalPrice = (catalog: Catalog, config: Config) =>
  priceLines(catalog, config).reduce((sum, line) => sum + line.price, 0);

// Location avec option d'achat, calcul indicatif : apport, valeur résiduelle, taux annuel.
export function monthly(catalog: Catalog, total: number): number {
  const { months, deposit, rate, residual } = catalog.financing;
  const r = rate / 12;
  const financed = total - deposit - (total * residual) / Math.pow(1 + r, months);
  return Math.max(0, Math.round((financed * r) / (1 - Math.pow(1 + r, -months))));
}

// URL partageable et lisible : ?c=gt.carmin.bronze.rouge.perle.toit+audio
export function encodeConfig(config: Config): string {
  return [config.trim, config.paint, config.wheels, config.calipers, config.interior, config.options.join('+')].join('.');
}

export function decodeConfig(catalog: Catalog, value: string | null): Config {
  const base = defaultConfig(catalog);
  if (!value) return base;
  const [trim, paint, wheels, calipers, interior, options] = value.split('.');
  return {
    trim: trim || base.trim,
    paint: paint || base.paint,
    wheels: wheels || base.wheels,
    calipers: calipers || base.calipers,
    interior: interior || base.interior,
    options: options ? options.split('+').filter(Boolean) : [],
  };
}

const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
export const formatPrice = (value: number) => euro.format(value);
