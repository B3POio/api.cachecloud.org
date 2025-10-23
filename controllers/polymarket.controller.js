// controllers/polymarket.controller.js

// Public, read-only endpoints (no API key needed for reads)
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

/**
 * Abortable fetch with timeout (Node 18+).
 */
async function fetchWithTimeout(resource, { timeoutMs = 12000, ...options } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(resource, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function parseClobTokenIds(s) {
  if (!s) return [];
  return String(s)
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

/**
 * GET /polymarket/bitcoin
 * Query params:
 *  - limit=10 (max 50)
 *  - includeClosed=1 (include closed/inactive markets)
 *  - livePrices=1 (attach best bid/ask via CLOB)
 */
export async function getPolymarketBitcoin(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '10', 10), 50);
    const includeClosed = req.query.includeClosed === '1';
    const livePrices = req.query.livePrices === '1';

    // 1) Search events related to “bitcoin” (PUBLIC endpoint, no cookies needed)
    const searchUrl = new URL(`${GAMMA}/public-search`);
    searchUrl.searchParams.set('q', 'bitcoin');
    searchUrl.searchParams.set('keep_closed_markets', includeClosed ? '1' : '0');
    searchUrl.searchParams.set('limit_per_type', String(limit));
    searchUrl.searchParams.set('search_tags', '0');
    searchUrl.searchParams.set('search_profiles', '0');
    searchUrl.searchParams.set('optimized', '1');

    // optional, but helps certain CDNs: send basic headers
    const commonHeaders = { 'accept': 'application/json', 'user-agent': 'node-fetch' };

    const searchRes = await fetchWithTimeout(searchUrl, {
    timeoutMs: 12000,
    headers: commonHeaders
    });
    if (!searchRes.ok) {
    const txt = await searchRes.text().catch(() => '');
    throw new Error(`Gamma public-search failed: ${searchRes.status} ${txt}`);
    }
    const search = await searchRes.json();
    const events = Array.isArray(search?.events) ? search.events.slice(0, limit) : [];

    // 2) Hydrate each event to get markets
    const hydrated = await Promise.all(
      events.map(async (e) => {
        const evRes = await fetchWithTimeout(
          `${GAMMA}/events/slug/${encodeURIComponent(e.slug)}`,
          { timeoutMs: 12000 }
        );
        if (!evRes.ok) return null;
        return evRes.json();
      })
    );

    // 3) Flatten + filter markets
    const markets = [];
    for (const ev of hydrated) {
      if (!ev?.markets) continue;
      for (const m of ev.markets) {
        if (!includeClosed && (m.closed || m.active === false)) continue;

        markets.push({
          eventSlug: ev.slug,
          marketId: m.id,
          marketSlug: m.slug,
          question: m.question,
          outcomes: m.outcomes ?? null,
          gammaOutcomePrices: m.outcomePrices ?? null, // often [YES, NO] probabilities 0..1
          clobTokenIds: parseClobTokenIds(m.clobTokenIds),
          volume24hr: m.volume24hr ?? null,
          liquidity: m.liquidity ?? null,
          endDate: m.endDate ?? null,
        });
      }
    }

    // Heuristic: keep obvious BTC markets
    const btcMarkets = markets.filter(
      (m) =>
        /bitcoin|btc/i.test(m.question ?? '') ||
        /bitcoin|btc/i.test(m.marketSlug ?? '')
    );

    // 4) (optional) attach live best bid/ask from CLOB
    let data = btcMarkets;
    if (livePrices && btcMarkets.some((m) => m.clobTokenIds.length)) {
      const params = [];
      for (const m of btcMarkets) {
        for (const t of m.clobTokenIds) {
          params.push({ token_id: t, side: 'BUY' });  // best ask (what you pay)
          params.push({ token_id: t, side: 'SELL' }); // best bid (what you receive)
        }
      }

      const clobRes = await fetchWithTimeout(`${CLOB}/prices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params }),
        timeoutMs: 12000,
      });

      if (clobRes.ok) {
        const priceMap = await clobRes.json(); // { [token_id]: { BUY: "0.501", SELL: "0.498" } }
        data = btcMarkets.map((m) => {
          const live = {};
          for (const t of m.clobTokenIds) {
            const p = priceMap?.[t];
            if (p) live[t] = { buy: p.BUY ?? null, sell: p.SELL ?? null };
          }
          return { ...m, livePrices: Object.keys(live).length ? live : null };
        });
      }
    }

    // 5) normalize for frontend/consumers
    const response = data.map((m) => ({
      eventSlug: m.eventSlug,
      marketSlug: m.marketSlug,
      question: m.question,
      outcomes: m.outcomes,                 // array of outcome labels
      gammaOutcomePrices: m.gammaOutcomePrices, // usually [yesProb, noProb]
      clobTokenIds: m.clobTokenIds,        // [YES_token, NO_token]
      livePrices: m.livePrices ?? null,     // { tokenId: { buy, sell } }
      volume24hr: m.volume24hr,
      liquidity: m.liquidity,
      endDate: m.endDate,
      url: `https://polymarket.com/market/${m.marketSlug}`,
    }));

    res.set('Cache-Control', livePrices ? 'no-store' : 'public, max-age=30');
    return res.json({ count: response.length, data: response });
  } catch (err) {
    console.error('Polymarket controller error:', err);
    return res.status(500).json({ error: 'Failed to fetch Polymarket data' });
  }
}


/**
 * GET /polymarket/ethereum
 * Query params:
 *  - limit=10 (max 50)
 *  - includeClosed=1 (include closed/inactive markets)
 *  - livePrices=1 (attach best bid/ask via CLOB)
 */
export async function getPolymarketEthereum(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '10', 10), 50);
    const includeClosed = req.query.includeClosed === '1';
    const livePrices = req.query.livePrices === '1';

    // 1) Search events related to ethereum (PUBLIC endpoint, no cookies needed)
    const searchUrl = new URL(`${GAMMA}/public-search`);
    searchUrl.searchParams.set('q', 'ethereum');
    searchUrl.searchParams.set('keep_closed_markets', includeClosed ? '1' : '0');
    searchUrl.searchParams.set('limit_per_type', String(limit));
    searchUrl.searchParams.set('search_tags', '0');
    searchUrl.searchParams.set('search_profiles', '0');
    searchUrl.searchParams.set('optimized', '1');

    // optional, but helps certain CDNs: send basic headers
    const commonHeaders = { 'accept': 'application/json', 'user-agent': 'node-fetch' };

    const searchRes = await fetchWithTimeout(searchUrl, {
    timeoutMs: 12000,
    headers: commonHeaders
    });
    if (!searchRes.ok) {
    const txt = await searchRes.text().catch(() => '');
    throw new Error(`Gamma public-search failed: ${searchRes.status} ${txt}`);
    }
    const search = await searchRes.json();
    const events = Array.isArray(search?.events) ? search.events.slice(0, limit) : [];

    // 2) Hydrate each event to get markets
    const hydrated = await Promise.all(
      events.map(async (e) => {
        const evRes = await fetchWithTimeout(
          `${GAMMA}/events/slug/${encodeURIComponent(e.slug)}`,
          { timeoutMs: 12000 }
        );
        if (!evRes.ok) return null;
        return evRes.json();
      })
    );

    // 3) Flatten + filter markets
    const markets = [];
    for (const ev of hydrated) {
      if (!ev?.markets) continue;
      for (const m of ev.markets) {
        if (!includeClosed && (m.closed || m.active === false)) continue;

        markets.push({
          eventSlug: ev.slug,
          marketId: m.id,
          marketSlug: m.slug,
          question: m.question,
          outcomes: m.outcomes ?? null,
          gammaOutcomePrices: m.outcomePrices ?? null, // often [YES, NO] probabilities 0..1
          clobTokenIds: parseClobTokenIds(m.clobTokenIds),
          volume24hr: m.volume24hr ?? null,
          liquidity: m.liquidity ?? null,
          endDate: m.endDate ?? null,
        });
      }
    }

    // Heuristic: keep obvious BTC markets
    const ethMarkets = markets.filter(
      (m) =>
        /ethereum|eth/i.test(m.question ?? '') ||
        /ethereum|eth/i.test(m.marketSlug ?? '')
    );

    // 4) (optional) attach live best bid/ask from CLOB
    let data = ethMarkets;
    if (livePrices && ethMarkets.some((m) => m.clobTokenIds.length)) {
      const params = [];
      for (const m of ethMarkets) {
        for (const t of m.clobTokenIds) {
          params.push({ token_id: t, side: 'BUY' });  // best ask (what you pay)
          params.push({ token_id: t, side: 'SELL' }); // best bid (what you receive)
        }
      }

      const clobRes = await fetchWithTimeout(`${CLOB}/prices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params }),
        timeoutMs: 12000,
      });

      if (clobRes.ok) {
        const priceMap = await clobRes.json(); // { [token_id]: { BUY: "0.501", SELL: "0.498" } }
        data = ethMarkets.map((m) => {
          const live = {};
          for (const t of m.clobTokenIds) {
            const p = priceMap?.[t];
            if (p) live[t] = { buy: p.BUY ?? null, sell: p.SELL ?? null };
          }
          return { ...m, livePrices: Object.keys(live).length ? live : null };
        });
      }
    }

    // 5) normalize for frontend/consumers
    const response = data.map((m) => ({
      eventSlug: m.eventSlug,
      marketSlug: m.marketSlug,
      question: m.question,
      outcomes: m.outcomes,                 // array of outcome labels
      gammaOutcomePrices: m.gammaOutcomePrices, // usually [yesProb, noProb]
      clobTokenIds: m.clobTokenIds,        // [YES_token, NO_token]
      livePrices: m.livePrices ?? null,     // { tokenId: { buy, sell } }
      volume24hr: m.volume24hr,
      liquidity: m.liquidity,
      endDate: m.endDate,
      url: `https://polymarket.com/market/${m.marketSlug}`,
    }));

    res.set('Cache-Control', livePrices ? 'no-store' : 'public, max-age=30');
    return res.json({ count: response.length, data: response });
  } catch (err) {
    console.error('Polymarket controller error:', err);
    return res.status(500).json({ error: 'Failed to fetch Polymarket data' });
  }
}

/**
 * GET /polymarket/gold
 * Query params:
 *  - limit=10 (max 50)
 *  - includeClosed=1 (include closed/inactive markets)
 *  - livePrices=1 (attach best bid/ask via CLOB)
 */
export async function getPolymarketGold(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '10', 10), 50);
    const includeClosed = req.query.includeClosed === '1';
    const livePrices = req.query.livePrices === '1';

    // 1) Search events related to ethereum (PUBLIC endpoint, no cookies needed)
    const searchUrl = new URL(`${GAMMA}/public-search`);
    searchUrl.searchParams.set('q', 'gold');
    searchUrl.searchParams.set('keep_closed_markets', includeClosed ? '1' : '0');
    searchUrl.searchParams.set('limit_per_type', String(limit));
    searchUrl.searchParams.set('search_tags', '0');
    searchUrl.searchParams.set('search_profiles', '0');
    searchUrl.searchParams.set('optimized', '1');

    // optional, but helps certain CDNs: send basic headers
    const commonHeaders = { 'accept': 'application/json', 'user-agent': 'node-fetch' };

    const searchRes = await fetchWithTimeout(searchUrl, {
    timeoutMs: 12000,
    headers: commonHeaders
    });
    if (!searchRes.ok) {
    const txt = await searchRes.text().catch(() => '');
    throw new Error(`Gamma public-search failed: ${searchRes.status} ${txt}`);
    }
    const search = await searchRes.json();
    const events = Array.isArray(search?.events) ? search.events.slice(0, limit) : [];

    // 2) Hydrate each event to get markets
    const hydrated = await Promise.all(
      events.map(async (e) => {
        const evRes = await fetchWithTimeout(
          `${GAMMA}/events/slug/${encodeURIComponent(e.slug)}`,
          { timeoutMs: 12000 }
        );
        if (!evRes.ok) return null;
        return evRes.json();
      })
    );

    // 3) Flatten + filter markets
    const markets = [];
    for (const ev of hydrated) {
      if (!ev?.markets) continue;
      for (const m of ev.markets) {
        if (!includeClosed && (m.closed || m.active === false)) continue;

        markets.push({
          eventSlug: ev.slug,
          marketId: m.id,
          marketSlug: m.slug,
          question: m.question,
          outcomes: m.outcomes ?? null,
          gammaOutcomePrices: m.outcomePrices ?? null, // often [YES, NO] probabilities 0..1
          clobTokenIds: parseClobTokenIds(m.clobTokenIds),
          volume24hr: m.volume24hr ?? null,
          liquidity: m.liquidity ?? null,
          endDate: m.endDate ?? null,
        });
      }
    }

    // Heuristic: keep obvious BTC markets
    const ethMarkets = markets.filter(
      (m) =>
        /gold|xau/i.test(m.question ?? '') ||
        /gold|xau/i.test(m.marketSlug ?? '')
    );

    // 4) (optional) attach live best bid/ask from CLOB
    let data = ethMarkets;
    if (livePrices && ethMarkets.some((m) => m.clobTokenIds.length)) {
      const params = [];
      for (const m of ethMarkets) {
        for (const t of m.clobTokenIds) {
          params.push({ token_id: t, side: 'BUY' });  // best ask (what you pay)
          params.push({ token_id: t, side: 'SELL' }); // best bid (what you receive)
        }
      }

      const clobRes = await fetchWithTimeout(`${CLOB}/prices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params }),
        timeoutMs: 12000,
      });

      if (clobRes.ok) {
        const priceMap = await clobRes.json(); // { [token_id]: { BUY: "0.501", SELL: "0.498" } }
        data = ethMarkets.map((m) => {
          const live = {};
          for (const t of m.clobTokenIds) {
            const p = priceMap?.[t];
            if (p) live[t] = { buy: p.BUY ?? null, sell: p.SELL ?? null };
          }
          return { ...m, livePrices: Object.keys(live).length ? live : null };
        });
      }
    }

    // 5) normalize for frontend/consumers
    const response = data.map((m) => ({
      eventSlug: m.eventSlug,
      marketSlug: m.marketSlug,
      question: m.question,
      outcomes: m.outcomes,                 // array of outcome labels
      gammaOutcomePrices: m.gammaOutcomePrices, // usually [yesProb, noProb]
      clobTokenIds: m.clobTokenIds,        // [YES_token, NO_token]
      livePrices: m.livePrices ?? null,     // { tokenId: { buy, sell } }
      volume24hr: m.volume24hr,
      liquidity: m.liquidity,
      endDate: m.endDate,
      url: `https://polymarket.com/market/${m.marketSlug}`,
    }));

    res.set('Cache-Control', livePrices ? 'no-store' : 'public, max-age=30');
    return res.json({ count: response.length, data: response });
  } catch (err) {
    console.error('Polymarket controller error:', err);
    return res.status(500).json({ error: 'Failed to fetch Polymarket data' });
  }
}

/**
 * GET /polymarket/silver
 * Query params:
 *  - limit=10 (max 50)
 *  - includeClosed=1 (include closed/inactive markets)
 *  - livePrices=1 (attach best bid/ask via CLOB)
 */
export async function getPolymarketSilver(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '10', 10), 50);
    const includeClosed = req.query.includeClosed === '1';
    const livePrices = req.query.livePrices === '1';

    // 1) Search events related to ethereum (PUBLIC endpoint, no cookies needed)
    const searchUrl = new URL(`${GAMMA}/public-search`);
    searchUrl.searchParams.set('q', 'silver');
    searchUrl.searchParams.set('keep_closed_markets', includeClosed ? '1' : '0');
    searchUrl.searchParams.set('limit_per_type', String(limit));
    searchUrl.searchParams.set('search_tags', '0');
    searchUrl.searchParams.set('search_profiles', '0');
    searchUrl.searchParams.set('optimized', '1');

    // optional, but helps certain CDNs: send basic headers
    const commonHeaders = { 'accept': 'application/json', 'user-agent': 'node-fetch' };

    const searchRes = await fetchWithTimeout(searchUrl, {
    timeoutMs: 12000,
    headers: commonHeaders
    });
    if (!searchRes.ok) {
    const txt = await searchRes.text().catch(() => '');
    throw new Error(`Gamma public-search failed: ${searchRes.status} ${txt}`);
    }
    const search = await searchRes.json();
    const events = Array.isArray(search?.events) ? search.events.slice(0, limit) : [];

    // 2) Hydrate each event to get markets
    const hydrated = await Promise.all(
      events.map(async (e) => {
        const evRes = await fetchWithTimeout(
          `${GAMMA}/events/slug/${encodeURIComponent(e.slug)}`,
          { timeoutMs: 12000 }
        );
        if (!evRes.ok) return null;
        return evRes.json();
      })
    );

    // 3) Flatten + filter markets
    const markets = [];
    for (const ev of hydrated) {
      if (!ev?.markets) continue;
      for (const m of ev.markets) {
        if (!includeClosed && (m.closed || m.active === false)) continue;

        markets.push({
          eventSlug: ev.slug,
          marketId: m.id,
          marketSlug: m.slug,
          question: m.question,
          outcomes: m.outcomes ?? null,
          gammaOutcomePrices: m.outcomePrices ?? null, // often [YES, NO] probabilities 0..1
          clobTokenIds: parseClobTokenIds(m.clobTokenIds),
          volume24hr: m.volume24hr ?? null,
          liquidity: m.liquidity ?? null,
          endDate: m.endDate ?? null,
        });
      }
    }

    // Heuristic: keep obvious BTC markets
    const ethMarkets = markets.filter(
      (m) =>
        /gold|xau/i.test(m.question ?? '') ||
        /gold|xau/i.test(m.marketSlug ?? '')
    );

    // 4) (optional) attach live best bid/ask from CLOB
    let data = ethMarkets;
    if (livePrices && ethMarkets.some((m) => m.clobTokenIds.length)) {
      const params = [];
      for (const m of ethMarkets) {
        for (const t of m.clobTokenIds) {
          params.push({ token_id: t, side: 'BUY' });  // best ask (what you pay)
          params.push({ token_id: t, side: 'SELL' }); // best bid (what you receive)
        }
      }

      const clobRes = await fetchWithTimeout(`${CLOB}/prices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params }),
        timeoutMs: 12000,
      });

      if (clobRes.ok) {
        const priceMap = await clobRes.json(); // { [token_id]: { BUY: "0.501", SELL: "0.498" } }
        data = ethMarkets.map((m) => {
          const live = {};
          for (const t of m.clobTokenIds) {
            const p = priceMap?.[t];
            if (p) live[t] = { buy: p.BUY ?? null, sell: p.SELL ?? null };
          }
          return { ...m, livePrices: Object.keys(live).length ? live : null };
        });
      }
    }

    // 5) normalize for frontend/consumers
    const response = data.map((m) => ({
      eventSlug: m.eventSlug,
      marketSlug: m.marketSlug,
      question: m.question,
      outcomes: m.outcomes,                 // array of outcome labels
      gammaOutcomePrices: m.gammaOutcomePrices, // usually [yesProb, noProb]
      clobTokenIds: m.clobTokenIds,        // [YES_token, NO_token]
      livePrices: m.livePrices ?? null,     // { tokenId: { buy, sell } }
      volume24hr: m.volume24hr,
      liquidity: m.liquidity,
      endDate: m.endDate,
      url: `https://polymarket.com/market/${m.marketSlug}`,
    }));

    res.set('Cache-Control', livePrices ? 'no-store' : 'public, max-age=30');
    return res.json({ count: response.length, data: response });
  } catch (err) {
    console.error('Polymarket controller error:', err);
    return res.status(500).json({ error: 'Failed to fetch Polymarket data' });
  }
}