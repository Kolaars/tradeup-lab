#!/usr/bin/env node
/**
 * Prints a ready-to-post "deal of the day" message with a shareable calculator link.
 *
 * Usage:
 *   node scripts/deal-post.mjs        # best deal
 *   node scripts/deal-post.mjs 2      # second best
 *   node scripts/deal-post.mjs --all  # all deals, separated
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TIERS_RU,
  WEARS_RU,
  defaultFloat,
  formatMoney,
  prepareCatalog,
} from '../assets/tradeup.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE_URL = 'https://kolaars.github.io/tradeup-lab/';

const [dealsPayload, itemsPayload] = await Promise.all([
  fs.readFile(path.join(ROOT, 'data', 'deals.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(ROOT, 'data', 'items.json'), 'utf8').then(JSON.parse),
]);

const catalog = prepareCatalog({
  items: itemsPayload.items,
  collections: itemsPayload.collections,
});

function shareLink(deal) {
  const slots = [];
  for (const input of deal.inputs) {
    const item = catalog.itemById.get(input.id);
    if (!item) continue;
    for (let n = 0; n < input.n; n += 1) {
      slots.push(`${input.id}:${input.wear}:${defaultFloat(item, input.wear).toFixed(4)}`);
    }
  }
  const params = new URLSearchParams();
  params.set('t', String(deal.tier));
  params.set('c', String(deal.coll));
  params.set('s', slots.join(','));
  return `${BASE_URL}?${params.toString()}`;
}

function signedPct(value) {
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function formatDeal(deal, index) {
  const collection = catalog.collections[deal.coll]?.n || 'Collection';
  const tier = `${TIERS_RU[deal.tier]} → ${TIERS_RU[deal.tier + 1]}`;
  const lines = [];

  lines.push(`🔥 Контракт дня №${index}: ${collection}`);
  lines.push(`${tier}`);
  lines.push('');
  lines.push(`Вход: ${formatMoney(deal.cost)} (10 скинов)`);
  lines.push(
    `EV: ${formatMoney(deal.ev)} · ROI ${signedPct(deal.roi)} · шанс плюса ${(deal.odds * 100).toFixed(0)}%`,
  );
  lines.push('');

  if (deal.outcomes?.length) {
    lines.push('Что может выпасть:');
    for (const outcome of deal.outcomes) {
      const item = catalog.itemById.get(outcome.id);
      if (!item) continue;
      lines.push(
        `• ${item.n} (${(outcome.prob * 100).toFixed(0)}%) — ${formatMoney(outcome.price)} · ${WEARS_RU[outcome.wear]}`,
      );
    }
    lines.push('');
  }

  lines.push('Расчёт и калькулятор:');
  lines.push(shareLink(deal));
  lines.push('');
  lines.push('Оценка по текущим ценам Steam, без комиссий. Не финансовая рекомендация.');

  return lines.join('\n');
}

const arg = process.argv[2];
const deals = dealsPayload.deals || [];

if (!deals.length) {
  console.error('No deals in data/deals.json. Run node scripts/build-data.mjs first.');
  process.exit(1);
}

if (arg === '--all') {
  console.log(deals.map((deal, index) => formatDeal(deal, index + 1)).join('\n\n---\n\n'));
} else {
  const index = Math.max(1, Number.parseInt(arg, 10) || 1);
  const deal = deals[index - 1];
  if (!deal) {
    console.error(`There are only ${deals.length} deals.`);
    process.exit(1);
  }
  console.log(formatDeal(deal, index));
}
