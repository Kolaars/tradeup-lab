/**
 * Trade-up contract math for CS2.
 *
 * Prices are stored in milli-USD (1/1000 of a dollar) to keep integers.
 * An item price cell is [normalMin, normalSteam, statTrakMin, statTrakSteam].
 */

export const WEARS = [
  'Factory New',
  'Minimal Wear',
  'Field-Tested',
  'Well-Worn',
  'Battle-Scarred',
];

export const WEARS_RU = [
  'Прямо с завода',
  'Немного поношенное',
  'После полевых',
  'Поношенное',
  'Закалённое в боях',
];

export const TIERS = [
  'Consumer Grade',
  'Industrial Grade',
  'Mil-Spec Grade',
  'Restricted',
  'Classified',
  'Covert',
];

export const TIERS_RU = [
  'Потребительское',
  'Промышленное',
  'Армейское',
  'Запрещённое',
  'Засекреченное',
  'Тайное',
];

export const RARITY_COLORS = [
  '#b0c3d9',
  '#5e98d9',
  '#4b69ff',
  '#8847ff',
  '#d32ce6',
  '#eb4b4b',
];

export const WEAR_RANGES = [
  [0.0, 0.07],
  [0.07, 0.15],
  [0.15, 0.38],
  [0.38, 0.45],
  [0.45, 1.0],
];

export function wearIndexOf(float) {
  const f = Number(float);
  if (!Number.isFinite(f)) return 4;
  if (f < 0.07) return 0;
  if (f < 0.15) return 1;
  if (f < 0.38) return 2;
  if (f < 0.45) return 3;
  return 4;
}

/** Overlap between the standard wear bucket and the skin's own float range. */
export function wearRange(item, wear) {
  const bucket = WEAR_RANGES[wear] || WEAR_RANGES[4];
  const lo = Math.max(bucket[0], item.f[0]);
  const hi = Math.min(bucket[1], item.f[1]);
  return [lo, Math.max(lo, hi)];
}

export function defaultFloat(item, wear) {
  const [lo, hi] = wearRange(item, wear);
  return (lo + hi) / 2;
}

export function maxFloatForWear(item, wear) {
  return wearRange(item, wear)[1];
}

/** [normalMin, normalSteam, stMin, stSteam] -> number | null */
export function getPrice(item, wear, mode = 'steam', stattrak = false) {
  const cell = item.p && item.p[wear];
  if (!cell) return null;
  const value = stattrak
    ? mode === 'market'
      ? cell[2]
      : cell[3]
    : mode === 'market'
      ? cell[0]
      : cell[1];
  return value > 0 ? value : null;
}

/** Cheapest available price for a skin, used by the picker. */
export function cheapestOffer(item, mode = 'steam', stattrak = false) {
  let best = null;
  for (let wear = 0; wear < WEARS.length; wear += 1) {
    const price = getPrice(item, wear, mode, stattrak);
    if (price == null) continue;
    if (!best || price < best.price) best = { price, wear };
  }
  return best;
}

function priceForFloat(item, float, mode, stattrak) {
  const clamped = Math.min(item.f[1], Math.max(item.f[0], float));
  const wear = wearIndexOf(clamped);
  for (let distance = 0; distance < WEARS.length; distance += 1) {
    const candidates = distance === 0 ? [wear] : [wear - distance, wear + distance];
    for (const candidate of candidates) {
      if (candidate < 0 || candidate >= WEARS.length) continue;
      const price = getPrice(item, candidate, mode, stattrak);
      if (price != null) {
        return { price, wear: candidate, approximate: candidate !== wear };
      }
    }
  }
  return null;
}

/**
 * Build an index once per catalog so repeated computations stay cheap.
 */
export function prepareCatalog(catalog) {
  if (catalog.__prepared) return catalog;
  catalog.itemById = new Map(catalog.items.map((item) => [item.id, item]));
  catalog.byCollection = new Map();
  for (const item of catalog.items) {
    const key = item.c[0];
    if (!catalog.byCollection.has(key)) catalog.byCollection.set(key, []);
    catalog.byCollection.get(key).push(item);
  }
  catalog.__prepared = true;
  return catalog;
}

function emptyResult() {
  return {
    cost: 0,
    ev: 0,
    profit: 0,
    roi: 0,
    odds: 0,
    avgFloat: 0,
    outcomes: [],
    unpricedProb: 0,
    pricedProb: 0,
    error: null,
  };
}

/**
 * @param {{id:string, wear:number, float?:number}[]} inputs up to 10 skins
 * @param {object} catalog prepared catalog { items, itemById, byCollection }
 * @param {{mode?:'steam'|'market', stattrak?:boolean}} options
 */
export function computeTradeup(inputs, catalog, options = {}) {
  prepareCatalog(catalog);
  const mode = options.mode === 'market' ? 'market' : 'steam';
  const stattrak = Boolean(options.stattrak);

  const resolved = [];
  for (const input of inputs) {
    const item = catalog.itemById.get(input.id);
    if (!item) continue;
    const wear = Math.min(4, Math.max(0, Number(input.wear)));
    const price = getPrice(item, wear, mode, stattrak);
    if (price == null) continue;
    const float = Number.isFinite(input.float)
      ? Math.min(item.f[1], Math.max(item.f[0], input.float))
      : defaultFloat(item, wear);
    resolved.push({ item, wear, price, float });
  }

  if (resolved.length === 0) return emptyResult();

  const tier = resolved[0].item.r;
  if (tier >= TIERS.length - 1) {
    return { ...emptyResult(), error: 'covert' };
  }
  if (resolved.some((entry) => entry.item.r !== tier)) {
    return { ...emptyResult(), error: 'mixed-tier' };
  }
  if (resolved.some((entry) => entry.item.c[0] !== resolved[0].item.c[0])) {
    // Different collections are allowed, but mixed StatTrak is not.
  }
  if (stattrak && resolved.some((entry) => !entry.item.st)) {
    return { ...emptyResult(), error: 'mixed-stattrak' };
  }

  const cost = resolved.reduce((sum, entry) => sum + entry.price, 0);
  const avgFloat = resolved.reduce((sum, entry) => sum + entry.float, 0) / resolved.length;

  const groups = new Map();
  for (const entry of resolved) {
    const collection = entry.item.c[0];
    groups.set(collection, (groups.get(collection) || 0) + 1);
  }

  const outcomes = [];
  for (const [collection, count] of groups) {
    const pool = (catalog.byCollection.get(collection) || []).filter(
      (item) =>
        item.r === tier + 1 &&
        (!stattrak || item.st === 1) &&
        cheapestOffer(item, mode, stattrak) != null,
    );
    if (pool.length === 0) continue;

    const groupWeight = count / resolved.length;
    const probability = groupWeight / pool.length;

    for (const item of pool) {
      const outFloat = Math.min(
        item.f[1],
        Math.max(item.f[0], avgFloat * (item.f[1] - item.f[0]) + item.f[0]),
      );
      const offer = priceForFloat(item, outFloat, mode, stattrak);
      outcomes.push({
        item,
        float: outFloat,
        wear: offer ? offer.wear : wearIndexOf(outFloat),
        approximate: offer ? offer.approximate : false,
        price: offer ? offer.price : null,
        prob: probability,
      });
    }
  }

  if (outcomes.length === 0) {
    return { ...emptyResult(), cost, error: 'no-outcomes' };
  }

  let ev = 0;
  let odds = 0;
  let unpricedProb = 0;
  let pricedProb = 0;

  for (const outcome of outcomes) {
    if (outcome.price == null) {
      unpricedProb += outcome.prob;
      continue;
    }
    pricedProb += outcome.prob;
    ev += outcome.prob * outcome.price;
    if (outcome.price > cost) odds += outcome.prob;
  }

  const profit = ev - cost;
  const roi = cost > 0 ? profit / cost : 0;

  outcomes.sort((a, b) => (b.price || 0) - (a.price || 0) || b.prob - a.prob);

  return {
    cost,
    ev,
    profit,
    roi,
    odds,
    avgFloat,
    outcomes,
    unpricedProb,
    pricedProb,
    error: null,
  };
}

export function formatMoney(milli, options = {}) {
  const value = (milli || 0) / 1000;
  const decimals = value !== 0 && Math.abs(value) < 0.01 ? 3 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: options.decimals ?? decimals,
    maximumFractionDigits: options.decimals ?? decimals,
  }).format(value);
}

export function formatPercent(value, decimals = 1) {
  return `${(value * 100).toFixed(decimals)}%`;
}
