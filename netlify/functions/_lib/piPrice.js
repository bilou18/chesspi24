// netlify/functions/_lib/piPrice.js
//
// Lookup of the Pi/USD rate for a sanity check on payment amounts (see
// products.js / isPlausibleAmount). Prefers the cache already populated by
// get-pi-price.js; if nothing has been cached yet (e.g. brand-new deploy,
// nobody has opened the price modal before the very first purchase),
// falls back to one direct, short-timeout CoinGecko fetch here rather than
// giving up.
//
// FIX: this file used to be two divergent copies — a simpler cache-only
// version living here (actually imported by approve.js) and a more
// complete version with a live-fetch fallback mistakenly left in
// netlify/functions/piPrice.js instead, where nothing ever required it.
// That meant the documented "BUG FIX" (adding a live fallback so a fresh
// deploy's first purchase isn't left with zero amount-checking) was never
// actually active. Consolidated here — this is now the only copy, and the
// orphaned top-level file has been removed.
//
// Callers (approve.js) now treat a null return as "reject the payment"
// (fail closed), not "skip the amount check" — see approve.js's amount
// check comment. This function still tries a live fetch before giving up,
// so null should only happen when the cache AND CoinGecko are both
// unreachable at the same moment.
const { getBlobStore } = require('./blobStore');
const axios = require('axios');

const CACHE_KEY = 'pi-usd-price';

async function fetchLiveFromCoinGecko() {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: { ids: 'pi-network', vs_currencies: 'usd' },
        timeout: 5000
    });
    const price = res.data && res.data['pi-network'] && res.data['pi-network'].usd;
    if (typeof price !== 'number' || !(price > 0)) throw new Error('CoinGecko: unexpected response shape');
    return price;
}

// Returns a number (the Pi/USD price) or null if there's truly no way to
// get one (cache empty AND live fetch failed). Never throws.
async function getCachedPiUsdRate() {
    try {
        const store = getBlobStore('pi-price-cache');
        const cached = await store.get(CACHE_KEY, { type: 'json' });
        if (cached && typeof cached.price === 'number' && cached.price > 0) {
            return cached.price;
        }
    } catch (e) {
        console.error('piPrice: cache read failed:', e.message);
    }

    // Nothing usable cached — try one live fetch before giving up, so the
    // amount check isn't left unenforceable just because no one has opened
    // the price modal yet.
    try {
        const price = await fetchLiveFromCoinGecko();
        // Best-effort: warm the shared cache too, so get-pi-price.js and
        // future payment checks benefit immediately. Not fatal if this
        // write fails — we still have the price to return below.
        try {
            const store = getBlobStore('pi-price-cache');
            await store.setJSON(CACHE_KEY, { price, source: 'coingecko', timestamp: Date.now() });
        } catch (writeErr) {
            console.error('piPrice: fallback cache write failed:', writeErr.message);
        }
        return price;
    } catch (liveErr) {
        console.error('piPrice: live fallback fetch failed:', liveErr.message);
    }

    return null;
}

module.exports = { getCachedPiUsdRate };
