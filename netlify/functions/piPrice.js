// netlify/functions/_lib/piPrice.js
//
// Lookup of the Pi/USD rate for a sanity check on payment amounts (see
// products.js / isPlausibleAmount). Prefers the cache already populated by
// get-pi-price.js; if nothing has been cached yet (e.g. brand-new deploy,
// nobody has opened the price modal before the very first purchase),
// falls back to one direct, short-timeout CoinGecko fetch here rather than
// giving up.
//
// BUG FIX: the previous version only ever read the cache. If it came back
// empty, approve.js's amount check is written as "if (piUsdRate && ...)" —
// i.e. it treats a null rate as "skip the check", not "reject". That was a
// reasonable design for "the price feed is down", but it also meant that
// on a fresh deploy — or any time the cache blob had been cleared — the
// very first purchase(s) went through with NO amount validation at all,
// so a tampered client could pay a token amount for Premium/any unlock.
// This fallback closes that gap for the common case (only truly failing
// closed-skip if CoinGecko itself is unreachable too).
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
// get one (cache empty AND live fetch failed). Never throws — callers
// should treat null as "skip the amount check this time" rather than fail
// the request outright.
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
    // amount check isn't silently skipped just because no one has opened
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
