// netlify/functions/complete.js
//
// SECURITY (fixed): the previous version just forwarded {paymentId, txid}
// to Pi's /complete endpoint and returned success — granting premium/
// purchases was left entirely to client-side JS (grantPremium()/
// recordPurchase() in script.js) which then pushed the result to
// save-progress.js. Since save-progress.js used to trust whatever
// progress object it was sent, a client could grant itself anything
// without ever paying. See save-progress.js's comment for the other half
// of this fix.
//
// This version is now the ONLY place a purchase actually gets applied to
// a player's stored progress:
//   1. Requires an 'approved' ledger record for this paymentId (written
//      by approve.js from data it fetched from Pi — never from the
//      client), and rejects if the record's uid doesn't match this
//      payment's uid.
//   2. Calls Pi's /complete endpoint.
//   3. Re-fetches the payment from Pi and requires status.developer_completed
//      to actually be true before granting anything.
//   4. Grants the entitlement server-side (grantEntitlement.js) and
//      returns the updated progress so the client can adopt it directly
//      instead of computing/asserting it itself.
//   5. Idempotent: if this paymentId was already completed, it returns
//      the previous result again instead of granting a second time.
const axios = require('axios');
const { getBlobStore } = require('./_lib/blobStore');
const { resolveProduct } = require('./_lib/products');
const { grantEntitlement } = require('./_lib/grantEntitlement');

exports.handler = async (event) => {
    const PI_API_KEY = process.env.PI_API_KEY;
    if (!PI_API_KEY) {
        console.error('complete: PI_API_KEY is not configured');
        return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured' }) };
    }

    try {
        if (!event.body) {
            return { statusCode: 400, body: JSON.stringify({ error: 'No body provided' }) };
        }

        const body = JSON.parse(event.body);
        const { paymentId, txid } = body;

        if (!paymentId || !txid) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing paymentId or txid' }) };
        }

        const paymentsStore = getBlobStore('payments');
        const record = await paymentsStore.get(paymentId, { type: 'json' }).catch(() => null);

        if (!record || record.status === 'cancelled') {
            console.error('complete: no approved ledger record for paymentId', paymentId);
            return { statusCode: 400, body: JSON.stringify({ error: 'Payment was not approved through this app' }) };
        }

        // Idempotent replay: already completed — return the same result
        // again instead of granting the entitlement a second time.
        if (record.status === 'completed') {
            return { statusCode: 200, body: JSON.stringify({ message: 'Completed', progress: record.grantedProgress || null, alreadyCompleted: true }) };
        }

        const axiosClient = axios.create({ baseURL: 'https://api.minepi.com' });
        const config = { headers: { 'Authorization': `Key ${PI_API_KEY}` }, timeout: 10000 };

        await axiosClient.post(`/v2/payments/${paymentId}/complete`, { txid }, config);

        // Re-fetch from Pi to get the authoritative post-completion status
        // rather than assuming the POST above succeeding means the payment
        // is actually settled.
        let payment;
        try {
            const paymentRes = await axiosClient.get(`/v2/payments/${paymentId}`, config);
            payment = paymentRes.data;
        } catch (fetchErr) {
            console.error('complete: could not re-fetch payment from Pi:', fetchErr.message);
            return { statusCode: 502, body: JSON.stringify({ error: 'Could not verify completed payment with Pi' }) };
        }

        const completed = !!(payment && payment.status && payment.status.developer_completed);
        if (!completed) {
            console.error('complete: Pi does not report this payment as completed', paymentId);
            return { statusCode: 400, body: JSON.stringify({ error: 'Payment is not confirmed complete' }) };
        }
        if (payment.user_uid !== record.uid) {
            console.error('complete: uid mismatch between ledger and Pi payment', { ledgerUid: record.uid, paymentUid: payment.user_uid });
            return { statusCode: 400, body: JSON.stringify({ error: 'Payment/user mismatch' }) };
        }

        const product = resolveProduct(record.productId);
        if (!product) {
            // Shouldn't happen — approve.js already validated this — but
            // never grant an entitlement for a product we can't resolve.
            console.error('complete: could not resolve productId at completion time', record.productId);
            return { statusCode: 400, body: JSON.stringify({ error: 'Unknown product' }) };
        }

        const updatedProgress = await grantEntitlement(record.uid, product);

        await paymentsStore.setJSON(paymentId, {
            ...record,
            status: 'completed',
            txid,
            completedAt: Date.now(),
            grantedProgress: updatedProgress
        });

        return { statusCode: 200, body: JSON.stringify({ message: 'Completed', progress: updatedProgress }) };
    } catch (error) {
        console.error('complete error:', error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Completion failed: ' + error.message }) };
    }
};
