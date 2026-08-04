// netlify/functions/save-progress.js
//
// Saves a player's progress (unlocked levels/themes), keyed by their Pi
// Network user ID (verified server-side via the access token, same as
// get-progress.js).
//
// SECURITY FIX: this endpoint used to accept and permanently merge in
// WHATEVER the client sent for purchasedLevels/purchasedThemes/
// purchasedPieceSets/premiumPlan/premiumExpiresAt. Since the only
// authentication here is "does this Pi access token belong to *some*
// account" (free — anyone can obtain one just by logging in), that meant
// anyone could grant themselves Pi Premium and every paid unlock forever
// by POSTing a forged progress object to this endpoint directly, without
// ever making a real Pi payment. The purchase-granting logic in script.js
// (grantPremium()/recordPurchase()) ran entirely client-side and simply
// trusted this endpoint to accept whatever it sent up.
//
// Fix: those five fields are now NEVER taken from the request body. They
// are only ever written by complete.js, after Pi's API confirms a real,
// completed payment (see complete.js and _lib/grantEntitlement.js) — this
// endpoint always carries forward whatever is already stored for them,
// no matter what the client includes in `progress`.
//
// unlockedLevels/unlockedThemes/unlockedPieceSets/triedLevels/
// triedThemes/triedPieceSets are still accepted from the client and
// merged (union) as before — those represent free/earned progress (e.g.
// beating a level, spending a one-time free trial) with no purchase
// behind them, so there's no payment fraud risk in trusting them. Note
// this does mean a modified client could still self-report having "won"
// a level it didn't — that's a separate, much lower-severity issue
// (skips ahead in single-player progression only; grants no VIP status,
// no leaderboard credit — see submit-score.js for how leaderboard scoring
// is protected — and no paid content) and is out of scope for this fix.
const axios = require('axios');
const { getBlobStore } = require('./_lib/blobStore');

const DEFAULT_PROGRESS = {
    unlockedLevels: ['easy'],
    unlockedThemes: ['brown'],
    unlockedPieceSets: ['neo'],
    premiumPlan: null,
    premiumExpiresAt: null,
    purchasedLevels: [],
    purchasedThemes: [],
    purchasedPieceSets: [],
    triedLevels: [],
    triedThemes: [],
    triedPieceSets: []
};

function union(a, b) {
    return Array.from(new Set([...(a || []), ...(b || [])]));
}

exports.handler = async (event) => {
    try {
        if (!event.body) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing request body' }) };
        }

        const body = JSON.parse(event.body);
        const accessToken = body.accessToken;
        const incomingProgress = body.progress;

        if (!accessToken || !incomingProgress) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing accessToken or progress' }) };
        }

        let uid;
        try {
            const meResponse = await axios.get('https://api.minepi.com/v2/me', {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 10000
            });
            uid = meResponse.data && meResponse.data.uid;
        } catch (verifyError) {
            console.error('Pi token verification failed:', verifyError.response ? verifyError.response.data : verifyError.message);
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired Pi access token' }) };
        }

        if (!uid) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Could not verify Pi user' }) };
        }

        const store = getBlobStore('player-progress');
        const existingProgress = (await store.get(uid, { type: 'json' })) || DEFAULT_PROGRESS;

        const mergedProgress = {
            unlockedLevels: union(existingProgress.unlockedLevels, incomingProgress.unlockedLevels),
            unlockedThemes: union(existingProgress.unlockedThemes, incomingProgress.unlockedThemes),
            unlockedPieceSets: union(existingProgress.unlockedPieceSets, incomingProgress.unlockedPieceSets),
            triedLevels: union(existingProgress.triedLevels, incomingProgress.triedLevels),
            triedThemes: union(existingProgress.triedThemes, incomingProgress.triedThemes),
            triedPieceSets: union(existingProgress.triedPieceSets, incomingProgress.triedPieceSets),

            // Purchase/subscription state: ALWAYS carried forward from
            // what's already stored, NEVER taken from incomingProgress.
            // Only complete.js (grantEntitlement.js) may change these.
            premiumPlan: existingProgress.premiumPlan || null,
            premiumExpiresAt: typeof existingProgress.premiumExpiresAt === 'number' ? existingProgress.premiumExpiresAt : null,
            purchasedLevels: existingProgress.purchasedLevels || [],
            purchasedThemes: existingProgress.purchasedThemes || [],
            purchasedPieceSets: existingProgress.purchasedPieceSets || []
        };

        // Defensive: anything ever purchased must always count as
        // unlocked, regardless of what the client's unlockedX arrays say.
        mergedProgress.unlockedLevels = union(mergedProgress.unlockedLevels, mergedProgress.purchasedLevels);
        mergedProgress.unlockedThemes = union(mergedProgress.unlockedThemes, mergedProgress.purchasedThemes);
        mergedProgress.unlockedPieceSets = union(mergedProgress.unlockedPieceSets, mergedProgress.purchasedPieceSets);

        await store.setJSON(uid, mergedProgress);

        return { statusCode: 200, body: JSON.stringify(mergedProgress) };
    } catch (error) {
        console.error('save-progress error:', error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save progress' }) };
    }
};
