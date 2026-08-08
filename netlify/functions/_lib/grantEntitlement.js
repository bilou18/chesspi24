// netlify/functions/_lib/grantEntitlement.js
//
// SECURITY: this is the only place in the whole backend allowed to set
// premiumExpiresAt / premiumPlan / purchasedLevels / purchasedThemes /
// purchasedPieceSets on a player's stored progress. It is called from
// complete.js, and only after: (a) Pi's API confirms the payment is
// developer_completed, and (b) we have our own "approved" ledger record
// (written by approve.js) proving this productId/uid pair was the one
// actually approved for this paymentId.
//
// save-progress.js explicitly refuses to accept these same fields from
// the client (see the comment there) — this function is what replaces
// that trust with a verified one.
const { getBlobStore } = require('./blobStore');

const DEFAULT_PROGRESS = {
    unlockedLevels: ['easy'],
    unlockedThemes: ['brown'],
    unlockedPieceSets: ['neo'],
    unlockedBotPersonalities: ['aggressive'],
    premiumPlan: null,
    premiumExpiresAt: null,
    purchasedLevels: [],
    purchasedThemes: [],
    purchasedPieceSets: [],
    purchasedBotPersonalities: [],
    earnedLevels: [],
    triedLevels: [],
    triedThemes: [],
    triedPieceSets: [],
    triedBotPersonalities: []
};

function union(a, b) {
    return Array.from(new Set([...(a || []), ...(b || [])]));
}

// Applies a resolved product (see products.js#resolveProduct) to uid's
// stored progress and persists the result. Returns the updated progress
// object. `plan`/`extraDays` are only used for kind === 'premium'.
async function grantEntitlement(uid, product) {
    const store = getBlobStore('player-progress');
    const existing = (await store.get(uid, { type: 'json' }).catch(() => null)) || DEFAULT_PROGRESS;

    const progress = {
        unlockedLevels: [...(existing.unlockedLevels || DEFAULT_PROGRESS.unlockedLevels)],
        unlockedThemes: [...(existing.unlockedThemes || DEFAULT_PROGRESS.unlockedThemes)],
        unlockedPieceSets: [...(existing.unlockedPieceSets || DEFAULT_PROGRESS.unlockedPieceSets)],
        unlockedBotPersonalities: [...(existing.unlockedBotPersonalities || DEFAULT_PROGRESS.unlockedBotPersonalities)],
        premiumPlan: existing.premiumPlan || null,
        premiumExpiresAt: typeof existing.premiumExpiresAt === 'number' ? existing.premiumExpiresAt : null,
        purchasedLevels: [...(existing.purchasedLevels || [])],
        purchasedThemes: [...(existing.purchasedThemes || [])],
        purchasedPieceSets: [...(existing.purchasedPieceSets || [])],
        purchasedBotPersonalities: [...(existing.purchasedBotPersonalities || [])],
        earnedLevels: [...(existing.earnedLevels || [])],
        triedLevels: [...(existing.triedLevels || [])],
        triedThemes: [...(existing.triedThemes || [])],
        triedPieceSets: [...(existing.triedPieceSets || [])],
        triedBotPersonalities: [...(existing.triedBotPersonalities || [])]
    };

    if (product.kind === 'premium') {
        // Extend from whichever is later: an already-active subscription's
        // current expiry, or now. Never lets a renewal shorten existing time.
        const base = (progress.premiumExpiresAt && progress.premiumExpiresAt > Date.now())
            ? progress.premiumExpiresAt
            : Date.now();
        progress.premiumExpiresAt = base + product.days * 24 * 60 * 60 * 1000;
        progress.premiumPlan = product.plan;
    } else if (product.kind === 'single') {
        const unlockedKey = `unlocked${capitalize(product.category)}`;
        const purchasedKey = `purchased${capitalize(product.category)}`;
        progress[unlockedKey] = union(progress[unlockedKey], [product.item]);
        progress[purchasedKey] = union(progress[purchasedKey], [product.item]);
    } else if (product.kind === 'bundle') {
        const unlockedKey = `unlocked${capitalize(product.category)}`;
        const purchasedKey = `purchased${capitalize(product.category)}`;
        progress[unlockedKey] = union(progress[unlockedKey], product.items);
        progress[purchasedKey] = union(progress[purchasedKey], product.items);
    }
    // 'refill' grants nothing persistent — it's a session/attempts top-up
    // handled client-side for the current game only, not stored progress.

    await store.setJSON(uid, progress);
    return progress;
}

function capitalize(categoryKey) {
    // 'levels' -> 'Levels', 'themes' -> 'Themes', 'piecesets' -> 'PieceSets',
    // 'botpersonalities' -> 'BotPersonalities'
    if (categoryKey === 'piecesets') return 'PieceSets';
    if (categoryKey === 'botpersonalities') return 'BotPersonalities';
    return categoryKey.charAt(0).toUpperCase() + categoryKey.slice(1);
}

module.exports = { grantEntitlement, DEFAULT_PROGRESS };
