#!/usr/bin/env node
/**
 * Builds data/items.json and data/deals.json.
 *
 * Sources:
 *  - skin metadata: ByMykel/CSGO-API (CC BY 4.0 data, images belong to Valve)
 *  - prices: Waxpeer public API (milli-USD)
 *
 * Run: node scripts/build-data.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WEARS,
  WEAR_RANGES,
  TIERS,
  RARITY_COLORS,
  computeTradeup,
  defaultFloat,
  getPrice,
  maxFloatForWear,
  prepareCatalog,
} from '../assets/tradeup.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CACHE_DIR = path.join(ROOT, '.cache');
const DATA_DIR = path.join(ROOT, 'data');

const SKINS_URL =
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json';
const PRICES_URL = 'https://api.waxpeer.com/v1/prices?game=csgo';

const SKINS_CACHE = path.join(CACHE_DIR, 'skins.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TradeUpLab/1.0 (+https://github.com/Kolaars/tradeup-lab)';

async function fetchJson(url, { cacheFile, maxAgeMs = 0 } = {}) {
  if (cacheFile && maxAgeMs > 0) {
    try {
      const stat = await fs.stat(cacheFile);
      if (Date.now() - stat.mtimeMs < maxAgeMs) {
        return JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      }
    } catch {
      /* cache miss */
    }
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const json = await response.json();
      if (cacheFile) {
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify(json));
      }
      return json;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

function priceCell(entry) {
  if (!entry) return [0, 0, 0, 0];
  return [
    Number(entry.min) > 0 ? Number(entry.min) : 0,
    Number(entry.steam_price) > 0 ? Number(entry.steam_price) : 0,
    0,
    0,
  ];
}

function statTrakCell(entry) {
  if (!entry) return [0, 0];
  return [
    Number(entry.min) > 0 ? Number(entry.min) : 0,
    Number(entry.steam_price) > 0 ? Number(entry.steam_price) : 0,
  ];
}

function hasAnyPrice(cell) {
  return cell && cell.some((value) => value > 0);
}

async function main() {
  console.log('→ fetching skin metadata');
  const skins = await fetchJson(SKINS_URL, {
    cacheFile: SKINS_CACHE,
    maxAgeMs: 6 * 60 * 60 * 1000,
  });

  console.log('→ fetching Waxpeer prices');
  const priceResponse = await fetchJson(PRICES_URL);
  if (!priceResponse || !Array.isArray(priceResponse.items)) {
    throw new Error('Unexpected Waxpeer response');
  }
  console.log(`  ${priceResponse.items.length} priced items`);

  const priceMap = new Map(priceResponse.items.map((entry) => [entry.name, entry]));
  const collectionIndex = new Map();
  const collections = [];
  const items = [];
  let matchedCells = 0;
  let totalCells = 0;
  let statTrakItems = 0;

  const eligible = skins
    .filter((skin) => {
      const tier = TIERS.indexOf(skin.rarity?.name);
      if (tier < 0 || tier > TIERS.length - 1) return false;
      if (!Array.isArray(skin.collections) || skin.collections.length === 0) return false;
      if (skin.category?.name === 'Knives' || skin.category?.name === 'Gloves') return false;
      return true;
    })
    .sort((a, b) => {
      const tierDiff = TIERS.indexOf(a.rarity.name) - TIERS.indexOf(b.rarity.name);
      return tierDiff || a.name.localeCompare(b.name);
    });

  for (const skin of eligible) {
    const collection = skin.collections[0];
    if (!collectionIndex.has(collection.name)) {
      collectionIndex.set(collection.name, collections.length);
      collections.push({
        n: collection.name,
        i: collection.image || '',
      });
    }
    const collectionId = collectionIndex.get(collection.name);

    const prices = [];
    let itemHasStatTrak = false;
    let image = '';

    for (const wear of skin.wears) {
      const hashName = `${skin.name} (${wear.name})`;
      const normalEntry = priceMap.get(hashName);
      const normal = priceCell(normalEntry);
      if (!image && normalEntry?.img) image = normalEntry.img;
      let cell = normal;

      if (skin.stattrak) {
        const statTrakEntry = priceMap.get(`StatTrak™ ${hashName}`);
        const statTrak = statTrakCell(statTrakEntry);
        if (!image && statTrakEntry?.img) image = statTrakEntry.img;
        if (hasAnyPrice(statTrak)) {
          itemHasStatTrak = true;
          cell = [normal[0], normal[1], statTrak[0], statTrak[1]];
        }
      }

      totalCells += 1;
      if (hasAnyPrice(cell)) matchedCells += 1;
      const wearIndex = WEARS.indexOf(wear.name);
      prices[wearIndex] = hasAnyPrice(cell) ? cell : null;
    }

    if (!prices.some((cell) => hasAnyPrice(cell))) continue;

    if (itemHasStatTrak) statTrakItems += 1;

    items.push({
      id: skin.id,
      n: skin.name,
      w: skin.weapon?.name || skin.name.split(' | ')[0],
      r: TIERS.indexOf(skin.rarity.name),
      c: [collectionId],
      f: [Number(skin.min_float) || 0, Number(skin.max_float) || 1],
      i: image || skin.image || '',
      st: skin.stattrak ? 1 : 0,
      p: prices,
    });
  }

  console.log(`  ${items.length} trade-up eligible skins, ${collections.length} collections`);
  console.log(
    `  price coverage: ${((matchedCells / totalCells) * 100).toFixed(1)}% (${matchedCells}/${totalCells})`,
  );

  const generatedAt = new Date().toISOString();
  const catalog = prepareCatalog({
    collections,
    items,
  });

  // ---------------------------------------------------------------------------
  // Deals of the day: cheapest 10 inputs of one collection/tier, EV vs cost.
  // Ranked by midpoint-float ROI, with a worst-case (max float) sanity check.
  // ---------------------------------------------------------------------------

  const byId = catalog.itemById;
  const deals = [];
  const nowIso = generatedAt;

  for (let collectionId = 0; collectionId < collections.length; collectionId += 1) {
    const collectionItems = catalog.byCollection.get(collectionId) || [];
    for (let tier = 0; tier < TIERS.length - 1; tier += 1) {
      const inputsPool = collectionItems.filter((item) => item.r === tier);
      const outputPool = collectionItems.filter((item) => item.r === tier + 1);
      if (inputsPool.length < 2 || outputPool.length < 2) continue;

      const offers = [];
      for (const item of inputsPool) {
        for (let wear = 0; wear < WEARS.length; wear += 1) {
          const price = getPrice(item, wear, 'steam', false);
          if (price == null) continue;
          offers.push({ id: item.id, wear, price, float: defaultFloat(item, wear) });
        }
      }
      if (offers.length === 0) continue;
      offers.sort((a, b) => a.price - b.price);
      if (offers[0].price <= 0) continue;

      // Cap each exact (skin, wear) offer at 5 copies so deals stay buyable.
      const chosen = [];
      const usage = new Map();
      for (const offer of offers) {
        const key = `${offer.id}:${offer.wear}`;
        while (chosen.length < 10 && (usage.get(key) || 0) < 5) {
          chosen.push(offer);
          usage.set(key, (usage.get(key) || 0) + 1);
        }
        if (chosen.length === 10) break;
      }
      if (chosen.length < 10) continue;

      const midInputs = chosen.map((offer) => ({
        id: offer.id,
        wear: offer.wear,
        float: offer.float,
      }));
      const mid = computeTradeup(midInputs, catalog, { mode: 'steam', stattrak: false });
      if (mid.error || !mid.outcomes.length) continue;

      const worstInputs = chosen.map((offer) => {
        const item = byId.get(offer.id);
        return {
          id: offer.id,
          wear: offer.wear,
          float: Math.min(item.f[1], Math.max(item.f[0], maxFloatForWear(item, offer.wear) - 0.0001)),
        };
      });
      const worst = computeTradeup(worstInputs, catalog, { mode: 'steam', stattrak: false });

      if (mid.cost < 1000) continue; // at least $1
      if (mid.unpricedProb > 0.25) continue;
      if (mid.outcomes.length < 2) continue;
      if (mid.roi < 0.04) continue;
      if (mid.roi > 3) continue;
      if (worst.roi < -0.1) continue;

      const inputSummary = [];
      for (const offer of chosen) {
        const existing = inputSummary.find(
          (entry) => entry.id === offer.id && entry.wear === offer.wear,
        );
        if (existing) existing.n += 1;
        else inputSummary.push({ id: offer.id, wear: offer.wear, n: 1 });
      }

      deals.push({
        id: `${collectionId}-${tier}`,
        coll: collectionId,
        tier,
        inputs: inputSummary,
        cost: Math.round(mid.cost),
        ev: Math.round(mid.ev),
        profit: Math.round(mid.profit),
        roi: Number(mid.roi.toFixed(4)),
        worstEv: Math.round(worst.ev),
        worstRoi: Number(worst.roi.toFixed(4)),
        odds: Number(mid.odds.toFixed(4)),
        outcomes: mid.outcomes.slice(0, 6).map((outcome) => ({
          id: outcome.item.id,
          wear: outcome.wear,
          price: outcome.price,
          prob: Number(outcome.prob.toFixed(4)),
        })),
        updatedAt: nowIso,
      });
    }
  }

  deals.sort((a, b) => b.worstRoi - a.worstRoi || b.roi - a.roi);
  const topDeals = deals.slice(0, 24);

  const meta = {
    generatedAt,
    sources: {
      skins: 'ByMykel/CSGO-API',
      prices: 'Waxpeer public API',
    },
    counts: {
      items: items.length,
      collections: collections.length,
      statTrakItems,
      deals: topDeals.length,
      scannedDeals: deals.length,
    },
    wearNames: WEARS,
    wearRanges: WEAR_RANGES,
    tierNames: TIERS,
    rarityColors: RARITY_COLORS,
  };

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, 'items.json'),
    JSON.stringify({ meta, collections, items }),
  );
  await fs.writeFile(path.join(DATA_DIR, 'deals.json'), JSON.stringify({ meta, deals: topDeals }));

  console.log(`  top deals: ${topDeals.length} (scanned ${deals.length})`);
  if (topDeals.length) {
    const best = topDeals[0];
    console.log(
      `  best: ${collections[best.coll].n} / ${TIERS[best.tier]} → ROI ${(best.roi * 100).toFixed(1)}%`,
    );
  }
  console.log('✓ data written to data/items.json and data/deals.json');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
