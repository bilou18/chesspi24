// netlify/functions/cancel.js
//
// Minor hardening over the original: validates the body and adds a
// request timeout (matching approve.js/complete.js — the old version had
// neither), and marks the payment's ledger record (if one exists) as
// 'cancelled' so a captured/replayed complete.js call can never grant an
// entitlement for a payment that was cancelled.
const axios = require('axios');
const { getBlobStore } = require('./_lib/blobStore');

exports.handler = async (event) => {
    const PI_API_KEY = process.env.PI_API_KEY;
    if (!PI_API_KEY) {
        console.error('cancel: PI_API_KEY is not configured');
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

        await axiosClient.post(`/v2/payments/${paymentId}/cancel`, {}, config);

        try {
            const paymentsStore = getBlobStore('payments');
            const record = await paymentsStore.get(paymentId, { type: 'json' }).catch(() => null);
            if (record && record.status !== 'completed') {
                await paymentsStore.setJSON(paymentId, { ...record, status: 'cancelled', cancelledAt: Date.now() });
            }
        } catch (ledgerErr) {
            // Non-fatal — the Pi-side cancel above already succeeded, and
            // complete.js independently re-verifies with Pi before
            // granting anything, so a missed ledger update here can't by
            // itself cause a false grant.
            console.error('cancel: failed to update ledger record:', ledgerErr.message);
        }

        return { statusCode: 200, body: JSON.stringify({ message: 'Canceled' }) };
    } catch (error) {
        console.error('cancel error:', error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Cancel failed' }) };
    }
};
