// netlify/functions/submit-score.js
//
// Credits a finished game to a player's leaderboard entry. The only inputs
// trusted from the client are (a) which game token — issued by
// start-game.js — is being redeemed, and (b) the reported result
// (win/loss/draw). Difficulty and start time come from the signed token
// itself, not from the request body, and every stored number (wins,
// gamesPlayed, score, winRate) is derived here server-side from those
// verified values, incrementally on top of the player's existing entry.
// This replaces an earlier version that trusted cumulative totals
// (wins/gamesPlayed/score) sent directly by the client, which let anyone
// forge an arbitrary leaderboard position from the browser console.
//
// Also the sole place that persists FREE level progression (beating
// 'medium' unlocks 'hard', etc.) to a player's stored progress — see the
// "BUG FIX" comment further down for why it has to be here and not
// save-progress.js.
//
// Requires the same GAME_TOKEN_SECRET env var as start-game.js.
const axios = require('axios');
const crypto = require('crypto');
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

const { LEVEL_SEQUENCE } = require('./_lib/products');

const LEADERBOARD_TOP_KEY = '__leaderboard_top50__';
const TOP_N = 50;
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000; // must match start-game.js

// Points awarded for a WIN at each difficulty (mirrors
// DIFFICULTY_SCORE_WEIGHTS in script.js). This server-side copy is what
// actually determines the stored score now — the client's local copy is
// cosmetic only.
const DIFFICULTY_SCORE_WEIGHTS = { easy: 1, medium: 2, hard: 3, expert: 4 };

// A real game can't plausibly finish faster than this, even by resigning
// instantly. Exists to block "redeem a result a fraction of a second after
// start-game" scripted abuse — tune against real measured game lengths if
// these ever cause false positives for legitimate very-fast play.
const MIN_GAME_SECONDS = { easy: 3, medium: 5, hard: 5, expert: 5 };

function isBetter(a, b) {
    // true if entry a ranks above entry b (more weighted score, then
    // higher win rate). Falls back to raw wins for older entries saved
    // before the weighted-score field existed.
    const scoreA = Number.isFinite(a.score) ? a.score : (a.wins || 0);
    const scoreB = Number.isFinite(b.score) ? b.score : (b.wins || 0);
    if (scoreA !== scoreB) return scoreA > scoreB;
    return (Number(a.winRate) || 0) > (Number(b.winRate) || 0);
}

// Verifies the HMAC signature on a game token and returns its decoded
// claims, or null if the token is missing, malformed, or tampered with.
function verifyGameToken(gameToken) {
    const secret = process.env.GAME_TOKEN_SECRET;
    if (!secret || typeof gameToken !== 'string' || !gameToken.includes('.')) return null;

    const dotIndex = gameToken.lastIndexOf('.');
    const payloadB64 = gameToken.slice(0, dotIndex);
    const signature = gameToken.slice(dotIndex + 1);
    const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

    const sigBuf = Buffer.from(signature || '', 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    // Constant-time comparison so response timing can't leak signature bytes.
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    try {
        return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

exports.handler = async (event) => {
    try {
        if (event.httpMethod !== 'POST') {
            return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
        }
        if (!event.body) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing request body' }) };
        }
        if (!process.env.GAME_TOKEN_SECRET) {
            console.error('submit-score: GAME_TOKEN_SECRET is not configured');
            return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured' }) };
        }

        const body = JSON.parse(event.body);
        const accessToken = body.accessToken;
        const result = body.result; // 'win' | 'loss' | 'draw' — client-reported outcome

        if (!accessToken) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing accessToken' }) };
        }
        if (!['win', 'loss', 'draw'].includes(result)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid result' }) };
        }

        // Verify the token with Pi Network and get the real, server-confirmed
        // UID and username — never trust these from the client directly.
        let uid, username;
        try {
            const meResponse = await axios.get('https://api.minepi.com/v2/me', {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 10000
            });
            uid = meResponse.data && meResponse.data.uid;
            username = meResponse.data && meResponse.data.username;
        } catch (verifyError) {
            console.error('Pi token verification failed:', verifyError.response ? verifyError.response.data : verifyError.message);
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired Pi access token' }) };
        }
        if (!uid) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Could not verify Pi user' }) };
        }

        // Verify the signed game token from start-game.js. Difficulty and
        // timing come ONLY from here, never from the request body.
        const claims = verifyGameToken(body.gameToken);
        if (!claims || !claims.uid || !claims.difficulty || !claims.startTime || !claims.jti) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or missing game token' }) };
        }
        if (claims.uid !== uid) {
            console.error('submit-score: game token uid mismatch', { tokenUid: claims.uid, requestUid: uid });
            return { statusCode: 403, body: JSON.stringify({ error: 'Game token does not belong to this account' }) };
        }

        const now = Date.now();
        if (now - claims.startTime > TOKEN_TTL_MS) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Game token has expired' }) };
        }
        const elapsedSeconds = (now - claims.startTime) / 1000;
        const minSeconds = MIN_GAME_SECONDS[claims.difficulty] || 5;
        if (elapsedSeconds < minSeconds) {
            console.error('submit-score: rejected implausibly fast game', { uid, difficulty: claims.difficulty, elapsedSeconds });
            return { statusCode: 409, body: JSON.stringify({ error: 'Game finished implausibly fast' }) };
        }

        const store = getBlobStore('leaderboard');

        // Enforce single-use redemption: each game token may only ever be
        // turned into one leaderboard credit, blocking replay of a captured
        // request to farm repeated wins from a single game.
        const usedTokens = getBlobStore('used-game-tokens');
        const alreadyUsed = await usedTokens.get(claims.jti);
        if (alreadyUsed) {
            console.error('submit-score: game token already redeemed', { uid, jti: claims.jti });
            return { statusCode: 409, body: JSON.stringify({ error: 'Game token already used' }) };
        }
        await usedTokens.set(claims.jti, '1');

        const existing = await store.get(uid, { type: 'json' }).catch(() => null);
        const prevWins = (existing && Number.isFinite(existing.wins)) ? existing.wins : 0;
        const prevGamesPlayed = (existing && Number.isFinite(existing.gamesPlayed)) ? existing.gamesPlayed : 0;
        const prevScore = (existing && Number.isFinite(existing.score)) ? existing.score : 0;

        // Every number below is derived entirely from server-verified
        // inputs: the signed difficulty from the token, plus the
        // client-reported win/loss/draw result — never a client-supplied
        // total.
        const wins = prevWins + (result === 'win' ? 1 : 0);
        const gamesPlayed = prevGamesPlayed + 1;
        const score = prevScore + (result === 'win' ? (DIFFICULTY_SCORE_WEIGHTS[claims.difficulty] || 0) : 0);
        const winRate = gamesPlayed > 0 ? Math.round((wins / gamesPlayed) * 100) : 0;

        // VIP badge: active Pi Premium subscriber, or has ever paid Pi for
        // a theme/piece-set/level unlock (see recordPurchase()/
        // grantPremium() in script.js and the "player-progress" store
        // populated by save-progress.js). Recomputed from that record —
        // never trusted from the client — every time a score is submitted,
        // so the badge can't go stale for an active player. A lapsed
        // player (no recent games) still gets it refreshed sooner via
        // update-vip-status.js right after their purchase completes.
        const progress = await getBlobStore('player-progress').get(uid, { type: 'json' }).catch(() => null);

        // BUG FIX: a "win" here (at claims.difficulty — the real,
        // server-verified difficulty, downgraded to 'easy' by start-game.js
        // if the player wasn't entitled to what they requested) is exactly
        // the trusted signal needed to advance the FREE level-progression
        // path (easy -> medium -> hard -> expert), same as beating a level
        // was always meant to do (see LEVEL_SEQUENCE/getNextLevel in
        // script.js). This used to only ever happen client-side
        // (grantProgress() writing to localStorage) and was silently wiped
        // the moment it round-tripped through save-progress.js, because
        // that endpoint only ever persists purchased unlocks — never
        // anything the client claims to have earned. Recording it HERE
        // instead is safe to trust precisely because it's driven by the
        // signed, single-use game token (verified above), not by anything
        // the client asserts directly.
        if (result === 'win') {
            try {
                const diffIndex = LEVEL_SEQUENCE.indexOf(claims.difficulty);
                const nextLevel = (diffIndex >= 0 && diffIndex < LEVEL_SEQUENCE.length - 1)
                    ? LEVEL_SEQUENCE[diffIndex + 1]
                    : null;
                if (nextLevel) {
                    const base = progress || {
                        unlockedLevels: ['easy'], unlockedThemes: ['brown'], unlockedPieceSets: ['neo'], unlockedBotPersonalities: ['aggressive'],
                        premiumPlan: null, premiumExpiresAt: null,
                        purchasedLevels: [], purchasedThemes: [], purchasedPieceSets: [], purchasedBotPersonalities: [],
                        earnedLevels: [], triedLevels: [], triedThemes: [], triedPieceSets: [], triedBotPersonalities: []
                    };
                    const alreadyUnlocked = Array.isArray(base.unlockedLevels) && base.unlockedLevels.includes(nextLevel);
                    if (!alreadyUnlocked) {
                        const earnedLevels = Array.from(new Set([...(base.earnedLevels || []), nextLevel]));
                        const unlockedLevels = Array.from(new Set([...(base.unlockedLevels || ['easy']), nextLevel]));
                        await getBlobStore('player-progress').setJSON(uid, { ...base, earnedLevels, unlockedLevels });
                    }
                }
            } catch (progressErr) {
                // Non-fatal: the score/leaderboard update above already
                // succeeded, and a missed level-unlock here just means the
                // player sees it granted locally until their next sync.
                console.error('submit-score: failed to record earned level progress:', progressErr.message);
            }
        }

        const premiumActive = !!(progress && typeof progress.premiumExpiresAt === 'number' && progress.premiumExpiresAt > Date.now());
        const hasPurchase = !!(progress && (
            (progress.purchasedLevels && progress.purchasedLevels.length > 0) ||
            (progress.purchasedThemes && progress.purchasedThemes.length > 0) ||
            (progress.purchasedPieceSets && progress.purchasedPieceSets.length > 0) ||
            (progress.purchasedBotPersonalities && progress.purchasedBotPersonalities.length > 0)
        ));
        const isVip = premiumActive || hasPurchase;

        const entry = {
            uid,
            username: username || 'Guest',
            wins,
            gamesPlayed,
            winRate,
            score,
            isVip,
            updatedAt: new Date().toISOString()
        };

        await store.setJSON(uid, entry);

        // Keep the top-50 blob in sync so get-leaderboard.js never has to
        // scan every player. We only rewrite it when this update could
        // actually change the top 50 — i.e. the player was already on the
        // board (their row needs updating/re-sorting) or they now beat the
        // current #50 (or the board isn't full yet).
        try {
            let top = await store.get(LEADERBOARD_TOP_KEY, { type: 'json' });
            if (!Array.isArray(top)) top = [];

            const existingIndex = top.findIndex((e) => e.uid === uid);
            const wasOnBoard = existingIndex !== -1;
            const boardFull = top.length >= TOP_N;
            const beatsLast = !boardFull || isBetter(entry, top[top.length - 1]);

            if (wasOnBoard || beatsLast) {
                if (wasOnBoard) top.splice(existingIndex, 1);
                top.push(entry);
                top.sort((a, b) => {
                    const scoreA = Number.isFinite(a.score) ? a.score : (a.wins || 0);
                    const scoreB = Number.isFinite(b.score) ? b.score : (b.wins || 0);
                    if (scoreB !== scoreA) return scoreB - scoreA;
                    return (Number(b.winRate) || 0) - (Number(a.winRate) || 0);
                });
                if (top.length > TOP_N) top = top.slice(0, TOP_N);
                await store.setJSON(LEADERBOARD_TOP_KEY, top);
            }
        } catch (topError) {
            // The player's own score is already saved safely above; failing
            // to refresh the top-50 cache shouldn't fail the whole request.
            console.error('submit-score: failed to update top-50 cache:', topError.message);
        }

        return { statusCode: 200, body: JSON.stringify(entry) };
    } catch (error) {
        console.error('submit-score error:', error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to submit score' }) };
    }
};
