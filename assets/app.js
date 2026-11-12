import {
  TIERS,
  TIERS_RU,
  WEARS,
  WEARS_RU,
  RARITY_COLORS,
  computeTradeup,
  prepareCatalog,
  cheapestOffer,
  getPrice,
  defaultFloat,
  wearRange,
  formatMoney,
} from './tradeup.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const cfg = window.TRADEUP_CONFIG || {};
const MAX_SLOTS = 10;

const state = {
  catalog: null,
  deals: [],
  meta: null,
  tier: 2,
  coll: '',
  st: false,
  mode: 'steam',
  query: '',
  slots: [],
  showAllDeals: false,
};

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });

const money = (milli) => formatMoney(milli || 0);
const pct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const signedPct = (value, digits = 1) => `${value > 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;

function shortCollection(name) {
  return String(name || '')
    .replace(/^The\s+/, '')
    .replace(/\s+Collection$/, '');
}

function plural(n, forms) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

function wearLabel(wear) {
  return WEARS_RU[wear] || WEARS[wear] || '—';
}

function itemById(id) {
  return state.catalog?.itemById.get(id) || null;
}

function collectionName(index) {
  return shortCollection(state.catalog?.collections?.[index]?.n || '');
}

function cheapestFor(item) {
  return cheapestOffer(item, state.mode, state.st);
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2400);
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return 'только что';
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `обновлено ${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `обновлено ${hours} ч назад`;
  const days = Math.round(hours / 24);
  return `обновлено ${days} дн назад`;
}

/* -------------------------------------------------------------------------- */
/* URL state                                                                  */
/* -------------------------------------------------------------------------- */

function readUrl() {
  const params = new URLSearchParams(location.search);
  const tier = Number.parseInt(params.get('t'), 10);
  if (Number.isInteger(tier) && tier >= 0 && tier <= 4) state.tier = tier;
  state.st = params.get('st') === '1';
  state.mode = params.get('m') === 'market' ? 'market' : 'steam';
  state.coll = params.get('c') || '';

  const packed = params.get('s');
  if (!packed) return;
  for (const chunk of packed.split(',').slice(0, MAX_SLOTS)) {
    const [id, wearRaw, floatRaw] = chunk.split(':');
    const wear = Number.parseInt(wearRaw, 10);
    const float = Number.parseFloat(floatRaw);
    if (!id || !Number.isInteger(wear) || wear < 0 || wear > 4) continue;
    state.slots.push({ id, wear, float: Number.isFinite(float) ? float : null });
  }
}

function encodeSlots() {
  return state.slots
    .filter(Boolean)
    .map((slot) => `${slot.id}:${slot.wear}:${Number(slot.float ?? 0).toFixed(4)}`)
    .join(',');
}

function syncUrl() {
  const params = new URLSearchParams();
  params.set('t', String(state.tier));
  if (state.st) params.set('st', '1');
  if (state.mode === 'market') params.set('m', 'market');
  if (state.coll !== '') params.set('c', String(state.coll));
  const packed = encodeSlots();
  if (packed) params.set('s', packed);
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function shareUrl() {
  const params = new URLSearchParams();
  params.set('t', String(state.tier));
  if (state.st) params.set('st', '1');
  if (state.mode === 'market') params.set('m', 'market');
  if (state.coll !== '') params.set('c', String(state.coll));
  const packed = encodeSlots();
  if (packed) params.set('s', packed);
  return `${location.origin}${location.pathname}?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/* data                                                                       */
/* -------------------------------------------------------------------------- */

async function loadData() {
  const [itemsResponse, dealsResponse] = await Promise.all([
    fetch('data/items.json'),
    fetch('data/deals.json'),
  ]);
  if (!itemsResponse.ok) throw new Error(`items.json: HTTP ${itemsResponse.status}`);
  if (!dealsResponse.ok) throw new Error(`deals.json: HTTP ${dealsResponse.status}`);

  const itemsPayload = await itemsResponse.json();
  const dealsPayload = await dealsResponse.json();

  state.meta = itemsPayload.meta;
  state.catalog = prepareCatalog({
    items: itemsPayload.items,
    collections: itemsPayload.collections,
  });
  state.deals = dealsPayload.deals || [];

  // Drop ids that disappeared from the catalog.
  state.slots = state.slots.filter((slot) => {
    const item = itemById(slot.id);
    return item && item.r === state.tier && (!state.st || item.st === 1);
  });

  normalizeSlots();
}

function normalizeSlots() {
  state.slots = state.slots.slice(0, MAX_SLOTS).map((slot) => {
    const item = itemById(slot.id);
    if (!item) return null;
    let wear = slot.wear;
    if (getPrice(item, wear, state.mode, state.st) == null) {
      const offer = cheapestFor(item);
      if (!offer) return null;
      wear = offer.wear;
    }
    const [lo, hi] = wearRange(item, wear);
    const float = Number.isFinite(slot.float)
      ? Math.min(hi, Math.max(lo, slot.float))
      : defaultFloat(item, wear);
    return { id: slot.id, wear, float };
  });
}

/* -------------------------------------------------------------------------- */
/* rendering: shell                                                           */
/* -------------------------------------------------------------------------- */

function renderStats() {
  const counts = state.meta?.counts || {};
  $('#hero-stats').innerHTML = `
    <div><dt>Скины</dt><dd>${Number(counts.items || 0).toLocaleString('ru-RU')}</dd></div>
    <div><dt>Коллекции</dt><dd>${Number(counts.collections || 0).toLocaleString('ru-RU')}</dd></div>
    <div><dt>Контракты дня</dt><dd>${Number(counts.deals || 0).toLocaleString('ru-RU')}</dd></div>
  `;
  $('#updated-label').textContent = state.meta?.generatedAt ? relativeTime(state.meta.generatedAt) : '';

  if (state.deals.length) {
    const avgRoi = state.deals.reduce((sum, deal) => sum + deal.roi, 0) / state.deals.length;
    const avgOdds = state.deals.reduce((sum, deal) => sum + deal.odds, 0) / state.deals.length;
    $('#hero-ev').textContent = signedPct(avgRoi);
    $('#hero-odds').textContent = pct(avgOdds, 0);
  }

  $('#year').textContent = String(new Date().getFullYear());
  const affiliate = [cfg.waxpeerRef, cfg.skinportRef, cfg.csfloatRef].some(Boolean);
  $('#affiliate-note').hidden = !affiliate;
  if (cfg.github) {
    $('#gh-link').href = cfg.github;
    $('#footer-gh').href = cfg.github;
  }
}

function renderCollectionSelect() {
  const select = $('#coll-select');
  const options = (state.catalog?.collections || [])
    .map((collection, index) => ({
      index,
      name: shortCollection(collection.n),
      full: collection.n,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  select.innerHTML =
    '<option value="">Все коллекции</option>' +
    options
      .map(
        (option) =>
          `<option value="${option.index}">${esc(option.name)}</option>`,
      )
      .join('');

  if (state.coll !== '' && state.catalog.collections[state.coll]) {
    select.value = String(state.coll);
  } else {
    state.coll = '';
    select.value = '';
  }
}

function renderDeals() {
  const grid = $('#deals-grid');
  if (!state.deals.length) {
    grid.innerHTML = '<div class="picker-empty">Сегодня контрактов с положительной оценкой нет. Загляните позже.</div>';
    return;
  }

  const visible = state.deals.slice(0, state.showAllDeals ? state.deals.length : 9);

  const cards = visible
    .map((deal) => {
      const collection = state.catalog.collections[deal.coll];
      const tierColor = RARITY_COLORS[deal.tier] || '#fff';
      const outputs = (deal.outcomes || []).slice(0, 4);
      const rest = (deal.outcomes || []).length - outputs.length;
      const outlook = deal.worstRoi >= 0 ? `худший флоат: ${signedPct(deal.worstRoi)}` : `риск: ${signedPct(deal.worstRoi)}`;
      const outlookClass = deal.worstRoi >= 0 ? 'pos' : 'neg';

      return `
        <article class="deal-card">
          <div class="deal-top">
            <div>
              <div class="deal-coll" title="${esc(collection.n)}">${esc(shortCollection(collection.n))}</div>
              <div class="deal-meta">
                <span class="tier-chip" style="--tier-color:${tierColor}">${esc(TIERS_RU[deal.tier])} → ${esc(TIERS_RU[deal.tier + 1])}</span>
              </div>
            </div>
            <div class="deal-roi">
              <b class="${deal.roi >= 0 ? 'pos' : 'neg'}">${signedPct(deal.roi)}</b>
              <small>средний ROI</small>
            </div>
          </div>

          <div class="deal-metrics">
            <div><span>Вход</span><b>${money(deal.cost)}</b></div>
            <div><span>EV</span><b>${money(deal.ev)}</b></div>
            <div><span>Шанс плюса</span><b>${pct(deal.odds, 0)}</b></div>
          </div>

          <div class="deal-outcomes">
            ${outputs
              .map((outcome) => {
                const item = itemById(outcome.id);
                if (!item) return '';
                return `<img src="${esc(item.i)}" alt="${esc(item.n)}" loading="lazy" title="${esc(item.n)} — ${esc(wearLabel(outcome.wear))}">`;
              })
              .join('')}
            ${rest > 0 ? `<span class="outcome-more">+${rest}</span>` : ''}
          </div>

          <div class="deal-meta">
            <span class="${outlookClass}">${outlook}</span>
            <span>·</span>
            <span>${(deal.inputs || []).reduce((sum, input) => sum + input.n, 0)} скинов</span>
          </div>

          <button class="deal-start" type="button" data-deal="${deal.id}">Собрать контракт →</button>
        </article>
      `;
    })
    .join('');

  const more =
    state.deals.length > 9
      ? `<button class="deals-more" type="button" data-deals-more="1">${
          state.showAllDeals ? 'Свернуть' : `Показать все ${state.deals.length} контрактов`
        }</button>`
      : '';

  grid.innerHTML = cards + more;
}

/* -------------------------------------------------------------------------- */
/* rendering: picker                                                          */
/* -------------------------------------------------------------------------- */

function pickerItems() {
  if (!state.catalog) return [];
  const query = state.query.trim().toLowerCase();
  const rows = [];

  for (const item of state.catalog.items) {
    if (item.r !== state.tier) continue;
    if (state.st && item.st !== 1) continue;
    if (state.coll !== '' && item.c[0] !== Number(state.coll)) continue;
    if (query && !item.n.toLowerCase().includes(query) && !item.w.toLowerCase().includes(query)) {
      continue;
    }
    const offer = cheapestFor(item);
    if (!offer) continue;
    rows.push({ item, offer });
  }

  rows.sort((a, b) => a.offer.price - b.offer.price || a.item.n.localeCompare(b.item.n));
  return rows;
}

function renderPicker() {
  const list = $('#picker-list');
  const hint = $('#picker-hint');
  const rows = pickerItems();
  const filled = state.slots.filter(Boolean).length;

  hint.innerHTML = `<span>${rows.length} ${plural(rows.length, ['скин', 'скина', 'скинов'])}</span><span>${state.mode === 'steam' ? 'Steam' : 'маркетплейс'}${state.st ? ' · ST' : ''}</span>`;

  if (!rows.length) {
    list.innerHTML = '<div class="picker-empty">Ничего не найдено. Смените редкость, коллекцию или запрос.</div>';
    return;
  }

  const full = filled >= MAX_SLOTS;
  list.innerHTML = rows
    .slice(0, 60)
    .map(({ item, offer }) => {
      const color = RARITY_COLORS[item.r] || '#fff';
      return `
        <button class="pick" type="button" data-add="${esc(item.id)}" style="--rarity:${color}" ${
          full ? 'disabled title="Все 10 слотов заняты"' : ''
        }>
          <img src="${esc(item.i)}" alt="" loading="lazy" width="44" height="34">
          <span class="pick-body">
            <span class="pick-name">${esc(item.n)}</span>
            <span class="pick-sub">${esc(wearLabel(offer.wear))}${state.st ? ' · StatTrak' : ''}</span>
          </span>
          <span class="pick-price">${money(offer.price)}<small>от</small></span>
        </button>
      `;
    })
    .join('');
}

/* -------------------------------------------------------------------------- */
/* rendering: slots + summary                                                 */
/* -------------------------------------------------------------------------- */

function renderSlots() {
  const container = $('#slots');
  const filled = state.slots.filter(Boolean);
  const cards = [];

  for (let index = 0; index < MAX_SLOTS; index += 1) {
    const slot = state.slots[index];
    if (!slot) {
      cards.push(`
        <button class="slot slot-empty" type="button" data-empty="${index}" aria-label="Добавить скин в слот ${index + 1}">
          <span><span class="plus">+</span>Слот ${index + 1}</span>
        </button>
      `);
      continue;
    }

    const item = itemById(slot.id);
    if (!item) continue;
    const color = RARITY_COLORS[item.r] || '#fff';
    const [lo, hi] = wearRange(item, slot.wear);
    const price = getPrice(item, slot.wear, state.mode, state.st) || 0;

    const wearOptions = WEARS.map((_, wear) => {
      const wearPrice = getPrice(item, wear, state.mode, state.st);
      if (wearPrice == null) return '';
      return `<option value="${wear}" ${wear === slot.wear ? 'selected' : ''}>${esc(
        wearLabel(wear),
      )} · ${money(wearPrice)}</option>`;
    }).join('');

    cards.push(`
      <div class="slot slot-filled" style="--rarity:${color}">
        <img src="${esc(item.i)}" alt="" loading="lazy" width="62" height="52">
        <div class="slot-main">
          <div class="slot-name" title="${esc(item.n)}">${esc(item.n)}</div>
          <div class="slot-controls">
            <select data-wear="${index}" aria-label="Степень износа">
              ${wearOptions}
            </select>
            <input
              type="number"
              inputmode="decimal"
              step="0.0001"
              min="${lo.toFixed(4)}"
              max="${hi.toFixed(4)}"
              value="${Number(slot.float).toFixed(4)}"
              data-float="${index}"
              aria-label="Флоат"
              title="Флоат: ${lo.toFixed(4)} – ${hi.toFixed(4)}"
            >
          </div>
          <div class="slot-foot">
            <span>${esc(wearLabel(slot.wear))}</span>
            <span class="slot-price">${money(price)}</span>
          </div>
        </div>
        <button class="slot-remove" type="button" data-remove="${index}" aria-label="Убрать скин">✕</button>
      </div>
    `);
  }

  container.innerHTML = cards.join('');
  $('#calc-status').textContent = `${filled.length} / ${MAX_SLOTS}`;
}

function computeCurrent() {
  if (!state.catalog) return null;
  const inputs = state.slots
    .filter(Boolean)
    .map((slot) => ({ id: slot.id, wear: slot.wear, float: slot.float }));
  if (!inputs.length) return null;
  return computeTradeup(inputs, state.catalog, { mode: state.mode, stattrak: state.st });
}

function errorText(result) {
  switch (result?.error) {
    case 'covert':
      return 'Тайные (Covert) скины нельзя использовать во входе контракта.';
    case 'mixed-tier':
      return 'Все скины должны быть одной редкости.';
    case 'mixed-stattrak':
      return 'Нельзя смешивать StatTrak и обычные скины.';
    case 'no-outcomes':
      return 'У этой коллекции нет следующей редкости — контракт невозможен.';
    default:
      return 'Недостаточно данных для расчёта.';
  }
}

function renderSummary(result) {
  const box = $('#summary');
  const filled = state.slots.filter(Boolean);

  if (!state.catalog) {
    box.innerHTML = '<div class="summary-empty">Загрузка данных…</div>';
    return;
  }

  if (!filled.length) {
    box.innerHTML = `
      <div class="summary-head"><h3>Расчёт</h3><span class="dim">0 / 10</span></div>
      <div class="summary-empty">
        <b>Начните с поиска слева</b>
        Выберите редкость, добавьте 10 скинов — и здесь появится стоимость, EV и шансы.
      </div>
    `;
    return;
  }

  if (!result || result.error) {
    box.innerHTML = `
      <div class="summary-head"><h3>Расчёт</h3><span class="dim">${filled.length} / 10</span></div>
      <div class="summary-empty">${errorText(result)}</div>
      <button class="btn btn-sm" type="button" data-action="clear">Очистить</button>
    `;
    return;
  }

  const positive = result.profit >= 0;
  const warnClass = filled.length < MAX_SLOTS ? 'warn' : '';
  const coverage = result.pricedProb;

  box.innerHTML = `
    <div class="summary-head">
      <h3>Расчёт</h3>
      <span class="dim">${filled.length} / ${MAX_SLOTS}</span>
    </div>

    <div class="summary-big">
      <span class="summary-profit ${positive ? 'pos' : 'neg'}">${positive ? '+' : ''}${money(result.profit)}</span>
      <span class="summary-roi ${positive ? 'pos' : 'neg'}">${signedPct(result.roi)}</span>
    </div>
    <div class="dim" style="font-size:11.5px;margin-top:4px">ожидаемая прибыль на контракт</div>

    <div class="summary-grid">
      <div class="summary-cell"><span>Вход</span><b>${money(result.cost)}</b></div>
      <div class="summary-cell"><span>EV результата</span><b>${money(result.ev)}</b></div>
      <div class="summary-cell"><span>Шанс на плюс</span><b class="${result.odds >= 0.5 ? 'green' : ''}">${pct(result.odds, 0)}</b></div>
      <div class="summary-cell"><span>Средний флоат</span><b>${result.avgFloat.toFixed(4)}</b></div>
    </div>

    ${
      filled.length < MAX_SLOTS
        ? `<div class="summary-note warn">Добавьте ещё ${MAX_SLOTS - filled.length} ${plural(MAX_SLOTS - filled.length, ['скин', 'скина', 'скинов'])}. Сейчас это предпросмотр.</div>`
        : ''
    }
    ${
      coverage < 0.98
        ? `<div class="summary-note">Для ${pct(1 - coverage, 1)} исходов нет цены — они не входят в EV.</div>`
        : ''
    }

    <div class="summary-actions">
      <a class="btn btn-primary full" href="${esc(buyUrl())}" target="_blank" rel="sponsored noopener">
        Купить входные скины
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><path d="M6 3h7v7M13 3 5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M11 9v4H3V5h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </a>
      <button class="btn" type="button" data-action="share">Ссылка</button>
      <button class="btn" type="button" data-action="copy">Список</button>
      <button class="btn btn-ghost full" type="button" data-action="clear">Очистить</button>
    </div>
  `;
}

function renderOutcomes(result) {
  const panel = $('#outcomes-panel');
  const body = $('#outcomes-body');
  const meta = $('#outcomes-meta');

  if (!result || result.error || !result.outcomes?.length) {
    panel.hidden = true;
    body.innerHTML = '';
    return;
  }

  panel.hidden = false;
  meta.innerHTML = `${result.outcomes.length} ${plural(result.outcomes.length, ['исход', 'исхода', 'исходов'])} · покрытие ценами ${pct(result.pricedProb, 0)}`;
  const maxProb = Math.max(...result.outcomes.map((outcome) => outcome.prob));

  body.innerHTML = result.outcomes
    .map((outcome) => {
      const item = outcome.item;
      const delta = outcome.price == null ? null : outcome.price - result.cost;
      const deltaText = delta == null ? '—' : `${delta >= 0 ? '+' : ''}${money(delta)}`;
      const deltaClass = delta == null ? 'dim' : delta >= 0 ? 'pos' : 'neg';
      const wear = `${outcome.approximate ? '≈ ' : ''}${wearLabel(outcome.wear)}`;

      return `
        <tr>
          <td>
            <div class="oc-item">
              <img src="${esc(item.i)}" alt="" loading="lazy" width="42" height="32">
              <div>
                <div class="oc-name" title="${esc(item.n)}">${esc(item.n)}</div>
                <div class="oc-sub">${esc(wear)} · ${esc(collectionName(item.c[0]))}</div>
              </div>
            </div>
          </td>
          <td>
            <span class="oc-prob">
              <span class="prob-bar"><span style="width:${Math.max(2, (outcome.prob / maxProb) * 100)}%"></span></span>
              ${pct(outcome.prob, 1)}
            </span>
          </td>
          <td class="dim">${outcome.float.toFixed(4)}</td>
          <td>${outcome.price == null ? '<span class="dim">нет цены</span>' : money(outcome.price)}</td>
          <td class="${deltaClass}">${deltaText}</td>
        </tr>
      `;
    })
    .join('');
}

function buyUrl() {
  const base = 'https://waxpeer.com/';
  return cfg.waxpeerRef ? `${base}?ref=${encodeURIComponent(cfg.waxpeerRef)}` : base;
}

/* -------------------------------------------------------------------------- */
/* main render                                                                */
/* -------------------------------------------------------------------------- */

function renderAll() {
  renderStats();
  renderDeals();
  renderPicker();
  renderSlots();
  const result = computeCurrent();
  renderSummary(result);
  renderOutcomes(result);
}

function renderCalculator() {
  renderPicker();
  renderSlots();
  const result = computeCurrent();
  renderSummary(result);
  renderOutcomes(result);
}

/* -------------------------------------------------------------------------- */
/* actions                                                                    */
/* -------------------------------------------------------------------------- */

function addItem(id) {
  if (state.slots.filter(Boolean).length >= MAX_SLOTS) {
    toast('Все 10 слотов заняты');
    return;
  }
  const item = itemById(id);
  if (!item || item.r !== state.tier) return;
  const offer = cheapestFor(item);
  if (!offer) {
    toast('Для этого скина нет цены в выбранном режиме');
    return;
  }
  state.slots.push({ id, wear: offer.wear, float: defaultFloat(item, offer.wear) });
  syncUrl();
  renderCalculator();
  toast(`Добавлено: ${item.n}`);
}

function removeSlot(index) {
  state.slots.splice(index, 1);
  syncUrl();
  renderCalculator();
}

function clearSlots() {
  state.slots = [];
  syncUrl();
  renderCalculator();
  toast('Контракт очищен');
}

function copyText(text, message) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast(message),
      () => fallbackCopy(text, message),
    );
  } else {
    fallbackCopy(text, message);
  }
}

function fallbackCopy(text, message) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
    toast(message);
  } catch {
    toast('Не удалось скопировать');
  }
  area.remove();
}

function copyList() {
  const lines = state.slots.filter(Boolean).map((slot, index) => {
    const item = itemById(slot.id);
    const price = getPrice(item, slot.wear, state.mode, state.st) || 0;
    return `${index + 1}. ${item.n} — ${wearLabel(slot.wear)} — ${money(price)}`;
  });
  if (!lines.length) return;
  const result = computeCurrent();
  if (result && !result.error) {
    lines.push('');
    lines.push(`Вход: ${money(result.cost)} · EV: ${money(result.ev)} · ROI: ${signedPct(result.roi)}`);
  }
  copyText(lines.join('\n'), 'Список скопирован');
}

function loadDeal(dealId) {
  const deal = state.deals.find((entry) => String(entry.id) === String(dealId));
  if (!deal) return;
  state.tier = deal.tier;
  state.st = false;
  state.mode = 'steam';
  state.coll = String(deal.coll);
  state.slots = [];

  for (const input of deal.inputs) {
    const item = itemById(input.id);
    if (!item) continue;
    const wear = input.wear;
    for (let n = 0; n < input.n && state.slots.length < MAX_SLOTS; n += 1) {
      state.slots.push({ id: input.id, wear, float: defaultFloat(item, wear) });
    }
  }

  $('#tier-select').value = String(state.tier);
  $('#coll-select').value = String(state.coll);
  $('#st-toggle').checked = false;
  $('#mode-select').value = 'steam';

  syncUrl();
  renderAll();
  $('#calc').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Контракт загружен в калькулятор');
}

/* -------------------------------------------------------------------------- */
/* events                                                                     */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  $('#tier-select').addEventListener('change', (event) => {
    state.tier = Number(event.target.value);
    state.slots = [];
    state.coll = '';
    $('#coll-select').value = '';
    syncUrl();
    renderAll();
  });

  $('#coll-select').addEventListener('change', (event) => {
    state.coll = event.target.value;
    state.slots = [];
    syncUrl();
    renderAll();
  });

  $('#mode-select').addEventListener('change', (event) => {
    state.mode = event.target.value === 'market' ? 'market' : 'steam';
    normalizeSlots();
    syncUrl();
    renderAll();
  });

  $('#st-toggle').addEventListener('change', (event) => {
    state.st = event.target.checked;
    normalizeSlots();
    syncUrl();
    renderAll();
  });

  let searchTimer;
  $('#search').addEventListener('input', (event) => {
    state.query = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderPicker, 90);
  });

  $('#picker-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-add]');
    if (button) addItem(button.dataset.add);
  });

  $('#slots').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      removeSlot(Number(remove.dataset.remove));
      return;
    }
    const empty = event.target.closest('[data-empty]');
    if (empty) {
      $('#search').focus();
      $('.picker')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  $('#slots').addEventListener('change', (event) => {
    const wearSelect = event.target.closest('[data-wear]');
    if (wearSelect) {
      const index = Number(wearSelect.dataset.wear);
      const slot = state.slots[index];
      const item = itemById(slot.id);
      const wear = Number(wearSelect.value);
      slot.wear = wear;
      slot.float = defaultFloat(item, wear);
      syncUrl();
      renderCalculator();
    }
  });

  $('#slots').addEventListener('input', (event) => {
    const floatInput = event.target.closest('[data-float]');
    if (!floatInput) return;
    const index = Number(floatInput.dataset.float);
    const slot = state.slots[index];
    if (!slot) return;
    const item = itemById(slot.id);
    const [lo, hi] = wearRange(item, slot.wear);
    const value = Number.parseFloat(floatInput.value);
    if (Number.isFinite(value)) {
      slot.float = Math.min(hi, Math.max(lo, value));
      const result = computeCurrent();
      renderSummary(result);
      renderOutcomes(result);
    }
  });

  $('#slots').addEventListener('change', (event) => {
    const floatInput = event.target.closest('[data-float]');
    if (!floatInput) return;
    syncUrl();
    renderCalculator();
  });

  $('#summary').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'clear') clearSlots();
    if (button.dataset.action === 'share') copyText(shareUrl(), 'Ссылка на расчёт скопирована');
    if (button.dataset.action === 'copy') copyList();
  });

  $('#deals-grid').addEventListener('click', (event) => {
    const more = event.target.closest('[data-deals-more]');
    if (more) {
      state.showAllDeals = !state.showAllDeals;
      renderDeals();
      return;
    }
    const button = event.target.closest('[data-deal]');
    if (button) loadDeal(button.dataset.deal);
  });

  $('#cta-share').addEventListener('click', () => {
    copyText(shareUrl(), 'Ссылка на расчёт скопирована');
  });
}

/* -------------------------------------------------------------------------- */
/* boot                                                                       */
/* -------------------------------------------------------------------------- */

async function boot() {
  readUrl();
  bindEvents();

  try {
    await loadData();
  } catch (error) {
    console.error(error);
    $('#deals-grid').innerHTML =
      '<div class="picker-empty">Не удалось загрузить данные. Обновите страницу чуть позже.</div>';
    $('#picker-list').innerHTML =
      '<div class="picker-empty">Данные недоступны. Проверьте соединение и обновите страницу.</div>';
    return;
  }

  $('#tier-select').value = String(state.tier);
  $('#mode-select').value = state.mode;
  $('#st-toggle').checked = state.st;
  renderCollectionSelect();
  renderAll();
}

boot();
