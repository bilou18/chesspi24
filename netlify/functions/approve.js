// netlify/functions/approve.js
//
// SECURITY (fixed): the previous version only forwarded {paymentId} to
// Pi's /approve endpoint and returned success — it never recorded *what*
// was being bought, for whom, or for how much. That gap is what let a
// client skip payment entirely and just POST fabricated progress straight
// to save-progress.js (see the comment there for the full explanation).
//
// This version fetches the payment itself from Pi's API (GET
// /v2/payments/:id) instead of trusting anything from the request body
// except the paymentId — the uid, amount, and productId used below all
// come from Pi's servers, not the client. It then:
//   1. Resolves metadata.productId against the server-side catalog
//      (products.js) — unrecognized product ids are rejected outright.
//      For bundle products this also reads the player's real stored
//      progress so the expected price reflects how many items they
//      actually still have locked (see products.js#buildBundleProduct).
//   2. Sanity-checks the paid amount against that product's expected USD
//      price (generous tolerance — see products.js).
//   3. Calls Pi's /approve endpoint.
//   4. Writes a ledger record {uid, productId, amount, status: 'approved'}
//      keyed by paymentId — this is what complete.js requires before it
//      will grant anything, so completion can never happen for a payment
//      that was never legitimately approved through this path.
const axios = require('axios');
const { getBlobStore } = require('./_lib/blobStore');
const { resolveProduct, isPlausibleAmount } = require('./_lib/products');
const { getCachedPiUsdRate } = require('./_lib/piPrice');

exports.handler = async (event) => {
    const PI_API_KEY = process.env.PI_API_KEY;
    if (!PI_API_KEY) {
        console.error('approve: PI_API_KEY is not configured');
        return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured' }) };
    }

    try {
        if (!event.body) {
            return { statusCode: 400, body: JSON.stringify({ error: 'No body provided' }) };
        }

        const body = JSON.parse(event.body);
        const paymentId = body.paymentId;

        if (!paymentId || typeof paymentId !== 'string') {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing paymentId' }) };
        }

        const axiosClient = axios.create({ baseURL: 'https://api.minepi.com' });
        const config = { headers: { 'Authorization': `Key ${PI_API_KEY}` }, timeout: 10000 };

        // Authoritative source for who's paying, how much, and for what —
        // never trust these values if they were ever sent by the client.
        let payment;
        try {
            const paymentRes = await axiosClient.get(`/v2/payments/${paymentId}`, config);
            payment = paymentRes.data;
        } catch (fetchErr) {
            console.error('approve: could not fetch payment from Pi:', fetchErr.message);
            return { statusCode: 400, body: JSON.stringify({ error: 'Could not verify payment with Pi' }) };
        }

        const uid = payment && payment.user_uid;
        const amount = payment && Number(payment.amount);
        const productId = payment && payment.metadata && payment.metadata.productId;

        if (!uid || !(amount > 0)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Malformed payment from Pi' }) };
        }

        // For bundle products, price against how many items THIS player
        // actually still has locked right now — see products.js's
        // buildBundleProduct() for why this matters (previously bundles
        // were always priced as if only one item were locked, which let a
        // tampered client unlock a full 3-item category for a fraction of
        // the real price).
        const progressStore = getBlobStore('player-progress');
        const existingProgress = await progressStore.get(uid, { type: 'json' }).catch(() => null);
        const product = resolveProduct(productId, {
            unlockedLevels: existingProgress && existingProgress.unlockedLevels,
            unlockedThemes: existingProgress && existingProgress.unlockedThemes,
            unlockedPieceSets: existingProgress && existingProgress.unlockedPieceSets
        });
        if (!product) {
            console.error('approve: unrecognized productId, refusing to approve:', productId);
            return { statusCode: 400, body: JSON.stringify({ error: 'Unknown product' }) };
        }

        // Amount sanity check — see products.js for why this uses a wide
        // tolerance instead of an exact match.
        const piUsdRate = await getCachedPiUsdRate();
        if (piUsdRate && !isPlausibleAmount(amount, product.expectedUsd, piUsdRate)) {
            console.error('approve: payment amount implausibly low for product', { productId, amount, expectedUsd: product.expectedUsd, piUsdRate });
            return { statusCode: 400, body: JSON.stringify({ error: 'Payment amount does not match product price' }) };
        }

        await axiosClient.post(`/v2/payments/${paymentId}/approve`, {}, config);

        // Ledger entry — complete.js will refuse to grant anything for a
        // paymentId that isn't recorded here as 'approved'.
        const paymentsStore = getBlobStore('payments');
        await paymentsStore.setJSON(paymentId, {
            uid,
            productId,
            amount,
            status: 'approved',
            createdAt: Date.now()
        });

        return { statusCode: 200, body: JSON.stringify({ message: 'Approved' }) };
    } catch (error) {
        console.error('approve error:', error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Approval failed: ' + error.message }) };
    }
};
