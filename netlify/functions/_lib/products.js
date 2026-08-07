// netlify/functions/_lib/products.js
//
// SECURITY: this is the server-side source of truth for "what does this
// productId actually buy". It mirrors the pricing constants in script.js,
// but unlike script.js, THIS copy is the one that decides what actually
// gets written to a player's stored progress (unlockedX/purchasedX/
// premiumExpiresAt). The client's copy of these numbers is cosmetic —
// used only to show a price and build the Pi.createPayment() call — never
// trusted to say what was bought or for how much.
//
// If you change a price or add a new unlockable item, update it here too
// (and see PRICE_TOLERANCE_RATIO below for why an exact match isn't
// required).

const LOCKABLE_LEVELS = ['medium', 'hard', 'expert']; // 'easy' is free by default
const LOCKABLE_THEMES = ['green', 'pink', 'blue'];      // 'brown' is free by default
const LOCKABLE_PIECE_SETS = ['wood', 'glass', 'marble']; // 'neo' is free by default

// Full free-progression order (mirrors LEVEL_SEQUENCE in script.js). Used
// by submit-score.js to determine which level a verified win at
// `difficulty` earns next, and by start-game.js to recognize that earned
// unlock as real entitlement (not just purchases).
const LEVEL_SEQUENCE = ['easy', 'medium', 'hard', 'expert'];

const UNLOCK_PRICE_USD = 0.70;
const BUNDLE_DISCOUNT_RATE = 0.15;
const REFILL_PRICE_USD = 0.006;
const PREMIUM_MONTHLY_USD = 0.50;
const PREMIUM_YEARLY_USD = 4.00;
const PREMIUM_MONTHLY_DAYS = 30;
const PREMIUM_YEARLY_DAYS = 365;

// The client quotes a Pi price computed from get-pi-price.js at the moment
// the unlock modal opens, then refreshes it again right before charging —
// but the PI/USD market rate can still drift a little between that quote
// and when we verify here, and get-pi-price.js's own cache adds up to a
// few more minutes of slack. Reject only amounts that are wildly off
// (i.e. someone tampering with the client to pay a token amount for a
// premium item), not honest market movement.
const PRICE_TOLERANCE_RATIO = 0.5; // accept amounts down to 50% of expected

// Maps a Pi payment's metadata.productId to what it grants. Returns null
// for anything unrecognized — callers must treat that as "reject the
// payment", not "grant nothing but still mark it complete".
//
// `context` (optional) carries the player's CURRENT unlockedLevels/
// unlockedThemes/unlockedPieceSets, read server-side from their stored
// progress by the caller (approve.js) — never from the client. It's only
// used for bundle products, to price them against how many items are
// *actually* still locked for this specific player right now.
//
// BUG FIX: this used to always price every bundle as if only a single item
// were still locked (bundleUsd(1)), regardless of the real count, because
// the count wasn't known from productId alone. Combined with the 50%
// PRICE_TOLERANCE_RATIO below, that meant a player with all 3 items in a
// category still locked could unlock the entire category for as little as
// ~17% of its real price (bundleUsd(1) * 0.5, instead of bundleUsd(3) *
// tolerance) simply by tampering with the client to request a smaller Pi
// payment for the same productId — the server had no way to catch it.
// Now the expected price is computed from the player's real locked count.
function resolveProduct(productId, context = {}) {
    if (typeof productId !== 'string') return null;

    if (productId === 'premium_monthly') {
        return { kind: 'premium', plan: 'monthly', days: PREMIUM_MONTHLY_DAYS, expectedUsd: PREMIUM_MONTHLY_USD };
    }
    if (productId === 'premium_yearly') {
        return { kind: 'premium', plan: 'yearly', days: PREMIUM_YEARLY_DAYS, expectedUsd: PREMIUM_YEARLY_USD };
    }
    if (productId === 'refill') {
        return { kind: 'refill', expectedUsd: REFILL_PRICE_USD };
    }

    if (productId === 'unlock_all-levels') {
        return buildBundleProduct('levels', LOCKABLE_LEVELS, context.unlockedLevels);
    }
    if (productId === 'unlock_all-themes') {
        return buildBundleProduct('themes', LOCKABLE_THEMES, context.unlockedThemes);
    }
    if (productId === 'unlock_all-piecesets') {
        return buildBundleProduct('piecesets', LOCKABLE_PIECE_SETS, context.unlockedPieceSets);
    }

    let m = productId.match(/^unlock_level_(.+)$/);
    if (m && LOCKABLE_LEVELS.includes(m[1])) {
        return { kind: 'single', category: 'levels', item: m[1], expectedUsd: UNLOCK_PRICE_USD };
    }
    m = productId.match(/^unlock_theme_(.+)$/);
    if (m && LOCKABLE_THEMES.includes(m[1])) {
        return { kind: 'single', category: 'themes', item: m[1], expectedUsd: UNLOCK_PRICE_USD };
    }
    m = productId.match(/^unlock_pieceset_(.+)$/);
    if (m && LOCKABLE_PIECE_SETS.includes(m[1])) {
        return { kind: 'single', category: 'piecesets', item: m[1], expectedUsd: UNLOCK_PRICE_USD };
    }

    return null;
}

// A bundle's price varies with how many items were still locked when the
// player bought it (1, 2, or 3 remaining). `items` is the category's full
// list; `alreadyUnlocked` is what the player currently has (from their
// real, server-stored progress). expectedUsd is priced against exactly how
// many are still locked for THIS player right now — not a guess.
// Floors at 1 item's worth even if our records show none locked (e.g. a
// stale/partial progress read), so a bundle purchase can never be
// validated as free.
function buildBundleProduct(category, items, alreadyUnlocked) {
    const unlocked = Array.isArray(alreadyUnlocked) ? alreadyUnlocked : [];
    const lockedCount = Math.max(1, items.filter((item) => !unlocked.includes(item)).length);
    return { kind: 'bundle', category, items, expectedUsd: bundleUsd(lockedCount) };
}

function bundleUsd(fullCount) {
    return UNLOCK_PRICE_USD * fullCount * (1 - BUNDLE_DISCOUNT_RATE);
}

// True if `amountPi` is a plausible payment for `expectedUsd`, given
// `piUsdRate` (Pi's current USD price). Used to catch a tampered client
// sending a token amount ("0.0001 Pi") for a premium-priced product — not
// meant to catch honest price-feed drift, hence the generous tolerance.
function isPlausibleAmount(amountPi, expectedUsd, piUsdRate) {
    if (!(amountPi > 0) || !(expectedUsd > 0) || !(piUsdRate > 0)) return false;
    const expectedPi = expectedUsd / piUsdRate;
    return amountPi >= expectedPi * PRICE_TOLERANCE_RATIO;
}

module.exports = {
    LOCKABLE_LEVELS,
    LOCKABLE_THEMES,
    LOCKABLE_PIECE_SETS,
    LEVEL_SEQUENCE,
    PREMIUM_MONTHLY_DAYS,
    PREMIUM_YEARLY_DAYS,
    resolveProduct,
    isPlausibleAmount
};
