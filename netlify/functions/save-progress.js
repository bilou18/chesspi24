// netlify/functions/save-progress.js
//
// Saves a player's progress (unlocked levels/themes), keyed by their Pi
// Network user ID (verified server-side via the access token, same as
// get-progress.js).
//
// SECURITY FIX #1 (earlier): this endpoint used to accept and permanently
// merge in WHATEVER the client sent for purchasedLevels/purchasedThemes/
// purchasedPieceSets/premiumPlan/premiumExpiresAt. Since the only
// authentication here is "does this Pi access token belong to *some*
// account" (free — anyone can obtain one just by logging in), that meant
// anyone could grant themselves Pi Premium and every paid unlock forever
// by POSTing a forged progress object to this endpoint directly, without
// ever making a real Pi payment.
//
// Fix: those five fields are now NEVER taken from the request body. They
// are only ever written by complete.js, after Pi's API confirms a real,
// completed payment (see complete.js and _lib/grantEntitlement.js) — this
// endpoint always carries forward whatever is already stored for them,
// no matter what the client includes in `progress`.
//
// SECURITY FIX #2 (this change): unlockedLevels/unlockedThemes/
// unlockedPieceSets were PREVIOUSLY also accepted from the client and
// merged (union) in directly, on the theory that they only reflect
// "free/earned progress with no purchase behind it". That reasoning was
// wrong: these three arrays are exactly what isLevelUnlocked()/
// isThemeUnlocked()/isPieceSetUnlocked() in script.js check to decide
// whether a paid level/theme/piece-set is playable — they ARE the paid
// content gate, not a cosmetic trial record. A client could simply do
// `playerProgress.unlockedThemes.push('green','pink','blue')` (etc.) in
// the browser console and POST that here to permanently unlock every
// paid level/theme/piece-set for free, without ever going through
// approve.js/complete.js.
//
// Fix: unlockedLevels/unlockedThemes/unlockedPieceSets are now NEVER
// taken from the request body either. They are always recomputed
// server-side as DEFAULT_PROGRESS's free items + whatever is in
// purchasedLevels/purchasedThemes/purchasedPieceSets (which, per fix #1
// above, can only have been set by a verified completed payment). This
// mirrors exactly how grantEntitlement.js derives them.
//
// triedLevels/triedThemes/triedPieceSets are still accepted from the
// client and merged (union) — they only drive the one-time "free trial"
// UI hint and never affect what's actually unlocked, so there's no
// payment-fraud risk in trusting them. They're also validated against the
// known lockable-item lists so a tampered client can't stuff arbitrary
// junk strings into stored progress. Note a modified client can still
// self-report having "won" a level it didn't — that's a separate, much
// lower-severity issue (skips ahead in single-player progression only;
// grants no VIP status, no leaderboard credit — see submit-score.js — and
// no paid content) and is out of scope for this fix.
const axios = require('axios');
const { getBlobStore } = require('./_lib/blobStore');
const { LOCKABLE_LEVELS, LOCKABLE_THEMES, LOCKABLE_PIECE_SETS } = require('./_lib/products');

const DEFAULT_PROGRESS = {
    unlockedLevels: ['easy'],
    unlockedThemes: ['brown'],
    unlockedPieceSets: ['neo'],
    premiumPlan: null,
    premiumExpiresAt: null,
    purchasedLevels: [],
    purchasedThemes: [],
    purchasedPieceSets: [],
    earnedLevels: [],
    triedLevels: [],
    triedThemes: [],
    triedPieceSets: []
};

function union(a, b) {
    return Array.from(new Set([...(a || []), ...(b || [])]));
}

// Keeps only entries that are actually recognized lockable items (or
// already-known free defaults), so a tampered client can't pollute
// stored progress with arbitrary strings via triedX.
function filterKnown(arr, allowedList) {
    const allowed = new Set(allowedList);
    return (Array.isArray(arr) ? arr : []).filter((item) => typeof item === 'string' && allowed.has(item));
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
            // triedX: cosmetic "have they sampled this locked item once"
            // hints only — safe to merge from the client, but whitelisted
            // against the known lockable-item lists to keep stored data
            // clean.
            triedLevels: union(existingProgress.triedLevels, filterKnown(incomingProgress.triedLevels, LOCKABLE_LEVELS)),
            triedThemes: union(existingProgress.triedThemes, filterKnown(incomingProgress.triedThemes, LOCKABLE_THEMES)),
            triedPieceSets: union(existingProgress.triedPieceSets, filterKnown(incomingProgress.triedPieceSets, LOCKABLE_PIECE_SETS)),

            // Purchase/subscription state: ALWAYS carried forward from
            // what's already stored, NEVER taken from incomingProgress.
            // Only complete.js (grantEntitlement.js) may change these.
            premiumPlan: existingProgress.premiumPlan || null,
            premiumExpiresAt: typeof existingProgress.premiumExpiresAt === 'number' ? existingProgress.premiumExpiresAt : null,
            purchasedLevels: existingProgress.purchasedLevels || [],
            purchasedThemes: existingProgress.purchasedThemes || [],
            purchasedPieceSets: existingProgress.purchasedPieceSets || [],

            // Free level progression (beating 'medium' unlocks 'hard', etc.):
            // ALWAYS carried forward from what's already stored, NEVER taken
            // from incomingProgress either — only submit-score.js may add to
            // this, and only after verifying a real win via the signed game
            // token (see the "BUG FIX" comment there). Before this field
            // existed, a client-reported "I won and unlocked the next level"
            // had nowhere legitimate to persist, so every earned unlock was
            // silently wiped by mergedProgress.unlockedLevels below the
            // instant this endpoint was called.
            earnedLevels: existingProgress.earnedLevels || []
        };

        // unlockedLevels/unlockedThemes/unlockedPieceSets are NEVER taken
        // from incomingProgress (see SECURITY FIX #2 above) — they are
        // always exactly "free defaults + whatever was actually
        // purchased + whatever was actually earned by winning", recomputed
        // fresh from server-trusted data every time, the same way
        // grantEntitlement.js derives them.
        mergedProgress.unlockedLevels = union(union(DEFAULT_PROGRESS.unlockedLevels, mergedProgress.purchasedLevels), mergedProgress.earnedLevels);
        mergedProgress.unlockedThemes = union(DEFAULT_PROGRESS.unlockedThemes, mergedProgress.purchasedThemes);
        mergedProgress.unlockedPieceSets = union(DEFAULT_PROGRESS.unlockedPieceSets, mergedProgress.purchasedPieceSets);

        await store.setJSON(uid, mergedProgress);

        return { statusCode: 200, body: JSON.stringify(mergedProgress) };
    } catch (error) {
        console.error('save-progress error:', error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save progress' }) };
    }
};
