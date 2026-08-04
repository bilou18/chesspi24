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
// Requires an env var GAME_TOKEN_SECRET — a long random string, kept only
// on the server (Netlify site settings), never shipped to the client.
const axios = require('axios');
const crypto = require('crypto');

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'];
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours — generous upper bound on a real game; must match submit-score.js

function sign(payloadB64) {
    const secret = process.env.GAME_TOKEN_SECRET;
    if (!secret) throw new Error('GAME_TOKEN_SECRET is not configured');
    return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
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
        const difficulty = body.difficulty;

        if (!accessToken) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing accessToken' }) };
        }
        if (!VALID_DIFFICULTIES.includes(difficulty)) {
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

        const payload = {
            uid,
            difficulty,
            startTime: Date.now(),
            // Unique per token so submit-score.js can enforce single-use
            // redemption and block replay of the same token.
            jti: crypto.randomBytes(16).toString('hex')
        };
        const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const signature = sign(payloadB64);
        const gameToken = `${payloadB64}.${signature}`;

        return { statusCode: 200, body: JSON.stringify({ gameToken, expiresInMs: TOKEN_TTL_MS }) };
    } catch (error) {
        console.error('start-game error:', error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to start game' }) };
    }
};
