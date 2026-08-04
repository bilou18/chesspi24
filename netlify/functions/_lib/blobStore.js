// netlify/functions/_lib/blobStore.js
//
// Shared helper for opening a Netlify Blobs store, with the manual
// siteID/token override for deploys where Netlify's automatic Blobs
// configuration doesn't arrive (see get-leaderboard.js's original comment
// for context). Every function that touches Blobs should use this instead
// of keeping its own copy, so the fallback behaves identically everywhere.
const { getStore } = require('@netlify/blobs');

function getBlobStore(name) {
    const siteID = process.env.BLOBS_SITE_ID;
    const token = process.env.BLOBS_TOKEN;
    if (siteID && token) {
        return getStore({ name, siteID, token });
    }
    return getStore(name);
}

module.exports = { getBlobStore };
