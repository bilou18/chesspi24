// netlify/functions/_lib/piPrice.js
//
// Read-only lookup of the Pi/USD rate already cached by get-pi-price.js.
// Used only for a sanity check on payment amounts (see products.js /
// isPlausibleAmount) — never fetches a live price itself, so it can't add
// new failure modes or rate-limit pressure on top of what get-pi-price.js
// already handles.
const { getBlobStore } = require('./blobStore');

const CACHE_KEY = 'pi-usd-price';

// Returns a number (the last known Pi/USD price) or null if nothing has
// ever been cached yet (e.g. brand-new deploy, nobody has opened a price
// modal). Never throws — callers should treat null as "skip the amount
// check this time" rather than fail the request.
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
    return null;
}

module.exports = { getCachedPiUsdRate };
