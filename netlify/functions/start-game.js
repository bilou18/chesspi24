// netlify/functions/start-game.js
//
// Issues a short-lived, signed "game token" when a player begins a match.
// The token records who is playing, at what difficulty, and when the game
// started — signed with a server-only secret (GAME_TOKEN_SECRET) so it
// can't be forged or altered by the client. submit-score.js requires this
// token at the end of the game and uses the values baked into it (never
// whatever the client claims in the request body) to credit the
// leaderboard, and enforces a minimum elapsed time per difficulty so a
// result can't be reported faster than a real game could plausibly finish.
//
// SECURITY FIX: this used to sign whatever `difficulty` the client asked
// for, with no check that the player actually owns that difficulty
// (purchasedLevels / active Premium). Combined with submit-score.js
// trusting the client's self-reported win/loss/draw result, that let
// anyone farm the leaderboard's difficulty-weighted score (Easy=1x,
// Medium=2x, Hard=3x, Expert=4x) by repeatedly requesting an 'expert'
// token and immediately reporting a fabricated win — without ever
// purchasing 'expert' or playing a real game to a real conclusion.
//
// Fix: the requested difficulty is now checked against the player's real
// stored progress (same entitlement rule as isLevelUnlocked() in
// script.js: free 'easy', OR the level is in purchasedLevels, OR an
// active Premium subscription covers everything). If the player isn't
// entitled to the requested difficulty, the token is still issued (so the
// client's free-trial UX — sampling a locked difficulty once — keeps
// working) but its `difficulty` claim is silently downgraded to 'easy'
// for scoring purposes, so submit-score.js can never credit
// higher-than-owned score weight. This mirrors how the free trial already
// grants no *unlock* — it now also grants no elevated leaderboard credit.
//
// Also adds a minimal per-uid cooldown so a script can't fire many
// concurrent start-game calls to queue up a batch of valid tokens faster
// than a human could actually finish successive games.
//
// Requires an env var GAME_TOKEN_SECRET — a long random string, kept only
// on the server (Netlify site settings), never shipped to the client.
const axios = require('axios');
const crypto = require('crypto');
const { getBlobStore } = require('./_lib/blobStore');
const { LOCKABLE_LEVELS } = require('./_lib/products');

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'];
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours — generous upper bound on a real game; must match submit-score.js

// Matches MIN_GAME_SECONDS in submit-score.js — a new token for the same
// uid can't be issued faster than the previous difficulty's real game
// could plausibly have finished. This doesn't stop a patient scripted
// farmer, but it does stop the trivial "loop with no delay" case and caps
// the maximum possible farming rate.
const MIN_GAME_SECONDS = { easy: 3, medium: 5, hard: 5, expert: 5 };
const THROTTLE_KEY_PREFIX = 'last-start:';

function sign(payloadB64) {
    const secret = process.env.GAME_TOKEN_SECRET;
    if (!secret) throw new Error('GAME_TOKEN_SECRET is not configured');
    return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

// True if `level` is playable by this player right now, per their real
// server-stored progress — never the client's copy. Mirrors
// isLevelUnlocked() in script.js.
function isLevelEntitled(level, progress) {
    if (level === 'easy') return true;
    if (!progress) return false;
    const premiumActive = typeof progress.premiumExpiresAt === 'number' && progress.premiumExpiresAt > Date.now();
    if (premiumActive) return true;
    return Array.isArray(progress.purchasedLevels) && progress.purchasedLevels.includes(level);
}

exports.handler = async (event) => {
    try {
        if (event.httpMethod !== 'POST') {
            return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
        }
        if (!process.env.GAME_TOKEN_SECRET) {
            console.error('start-game: GAME_TOKEN_SECRET is not configured');
            return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured' }) };
        }
        if (!event.body) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing request body' }) };
        }

        const body = JSON.parse(event.body);
        const accessToken = body.accessToken;
        const requestedDifficulty = body.difficulty;

        if (!accessToken) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing accessToken' }) };
        }
        if (!VALID_DIFFICULTIES.includes(requestedDifficulty)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid difficulty' }) };
        }

        // Verify the token with Pi Network and get the real, server-confirmed
        // UID — never trust an identity from the client directly. This is
        // the same check used in submit-score.js / get-progress.js /
        // save-progress.js.
        let uid;
        try {
            const meResponse = await axios.get('https://api.minepi.com/v2/me', {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 10000
            });
            uid = meResponse.data && meResponse.data.uid;
        } catch (verifyError) {
            console.error('start-game: Pi token verification failed:', verifyError.response ? verifyError.response.data : verifyError.message);
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired Pi access token' }) };
        }
        if (!uid) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Could not verify Pi user' }) };
        }

        // Basic anti-farming cooldown: reject if this uid started a game
        // more recently than the minimum plausible duration for the
        // difficulty it started at. Best-effort — a throttle-store failure
        // never blocks legitimate play.
        const throttleStore = getBlobStore('game-start-throttle');
        try {
            const last = await throttleStore.get(THROTTLE_KEY_PREFIX + uid, { type: 'json' }).catch(() => null);
            if (last && typeof last.startTime === 'number' && typeof last.difficulty === 'string') {
                const minGapMs = (MIN_GAME_SECONDS[last.difficulty] || 5) * 1000;
                const elapsed = Date.now() - last.startTime;
                if (elapsed < minGapMs) {
                    return { statusCode: 429, body: JSON.stringify({ error: 'Please finish your current game before starting another.' }) };
                }
            }
        } catch (throttleErr) {
            console.error('start-game: throttle check failed (non-fatal):', throttleErr.message);
        }

        // Only grant the requested difficulty's leaderboard weight if the
        // player is actually entitled to it right now (free 'easy',
        // purchased, or covered by active Premium). Otherwise the token is
        // still issued — so a locked difficulty can still be sampled via
        // the client's free-trial UX — but downgraded to 'easy' so it can
        // never be redeemed for higher-than-owned score credit.
        let effectiveDifficulty = requestedDifficulty;
        if (LOCKABLE_LEVELS.includes(requestedDifficulty)) {
            const progressStore = getBlobStore('player-progress');
            const progress = await progressStore.get(uid, { type: 'json' }).catch(() => null);
            if (!isLevelEntitled(requestedDifficulty, progress)) {
                effectiveDifficulty = 'easy';
            }
        }

        const startTime = Date.now();
        const payload = {
            uid,
            difficulty: effectiveDifficulty,
            startTime,
            // Unique per token so submit-score.js can enforce single-use
            // redemption and block replay of the same token.
            jti: crypto.randomBytes(16).toString('hex')
        };
        const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const signature = sign(payloadB64);
        const gameToken = `${payloadB64}.${signature}`;

        try {
            await throttleStore.setJSON(THROTTLE_KEY_PREFIX + uid, { startTime, difficulty: effectiveDifficulty });
        } catch (throttleWriteErr) {
            console.error('start-game: throttle write failed (non-fatal):', throttleWriteErr.message);
        }

        return { statusCode: 200, body: JSON.stringify({ gameToken, expiresInMs: TOKEN_TTL_MS, difficulty: effectiveDifficulty }) };
    } catch (error) {
        console.error('start-game error:', error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to start game' }) };
    }
};
