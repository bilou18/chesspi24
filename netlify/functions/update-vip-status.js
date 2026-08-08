// netlify/functions/update-vip-status.js
//
// Recomputes a player's VIP flag (active Pi Premium subscriber, or has
// ever paid Pi for a theme/piece-set/level unlock) from their saved
// player-progress record, and patches it onto their existing leaderboard
// entry — if they have one — without requiring them to finish another
// game first. Called by the client right after a Premium purchase or a
// paid unlock completes (see recordPurchase()/grantPremium() in
// script.js). submit-score.js also (re)computes this on every score
// submission, so this endpoint only closes the gap between purchases.
//
// A no-op (200, isVip returned but nothing written) if the player doesn't
// have a leaderboard entry yet — nothing to patch until they play a
// ranked game, at which point submit-score.js will set it correctly.
const axios = require('axios');
const { getStore } = require('@netlify/blobs');

// See get-leaderboard.js for why this manual-override helper exists.
function getBlobStore(name) {
    const siteID = process.env.BLOBS_SITE_ID;
    const token = process.env.BLOBS_TOKEN;
    if (siteID && token) {
        return getStore({ name, siteID, token });
    }
    return getStore(name);
}

const LEADERBOARD_TOP_KEY = '__leaderboard_top50__';

function computeIsVip(progress) {
    if (!progress) return false;
    const premiumActive = typeof progress.premiumExpiresAt === 'number' && progress.premiumExpiresAt > Date.now();
    const hasPurchase = (progress.purchasedLevels && progress.purchasedLevels.length > 0)
        || (progress.purchasedThemes && progress.purchasedThemes.length > 0)
        || (progress.purchasedPieceSets && progress.purchasedPieceSets.length > 0)
        || (progress.purchasedBotPersonalities && progress.purchasedBotPersonalities.length > 0);
    return !!(premiumActive || hasPurchase);
}

exports.handler = async (event) => {
    try {
        if (!event.body) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing request body' }) };
        }

        const body = JSON.parse(event.body);
        const accessToken = body.accessToken;

        if (!accessToken) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing accessToken' }) };
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

        const progressStore = getBlobStore('player-progress');
        const progress = await progressStore.get(uid, { type: 'json' }).catch(() => null);
        const isVip = computeIsVip(progress);

        const leaderboardStore = getBlobStore('leaderboard');
        const entry = await leaderboardStore.get(uid, { type: 'json' }).catch(() => null);

        // Nothing on the leaderboard yet — nothing to patch. Not an error:
        // the badge will be set correctly whenever they do submit a score.
        if (!entry) {
            return { statusCode: 200, body: JSON.stringify({ isVip, leaderboardEntryUpdated: false }) };
        }

        if (entry.isVip === isVip) {
            return { statusCode: 200, body: JSON.stringify({ isVip, leaderboardEntryUpdated: false }) };
        }

        entry.isVip = isVip;
        await leaderboardStore.setJSON(uid, entry);

        // Keep the cached top-50 list (what get-leaderboard.js actually
        // serves) in sync too, if this player happens to be on it.
        try {
            let top = await leaderboardStore.get(LEADERBOARD_TOP_KEY, { type: 'json' });
            if (Array.isArray(top)) {
                const idx = top.findIndex((e) => e.uid === uid);
                if (idx !== -1) {
                    top[idx] = { ...top[idx], isVip };
                    await leaderboardStore.setJSON(LEADERBOARD_TOP_KEY, top);
                }
            }
        } catch (topError) {
            console.error('update-vip-status: failed to refresh top-50 cache:', topError.message);
        }

        return { statusCode: 200, body: JSON.stringify({ isVip, leaderboardEntryUpdated: true }) };
    } catch (error) {
        console.error('update-vip-status error:', error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update VIP status' }) };
    }
};
