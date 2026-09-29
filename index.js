"use strict";

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_API_KEY || "";
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const LANGUAGE = process.env.LANGUAGE || "cs-CZ";
const MAX_RATING = process.env.MAX_RATING || "PG";

const list = (value, fallback) =>
    (value === undefined ? fallback : value).split(",").map(s => s.trim()).filter(Boolean);

const EXCLUDE_LANGS = list(process.env.EXCLUDE_LANGS, "ja,ko,zh,cn").map(s => s.toLowerCase());
const EXCLUDE_COUNTRIES = list(process.env.EXCLUDE_COUNTRIES, "JP,KR,CN,TW,HK").map(s => s.toUpperCase());
const EXCLUDE_KEYWORDS = process.env.EXCLUDE_KEYWORDS !== undefined ? process.env.EXCLUDE_KEYWORDS : "210024";
const EXCLUDE_TV_GENRES = process.env.EXCLUDE_TV_GENRES !== undefined ? process.env.EXCLUDE_TV_GENRES : "80|10768|9648";

const PAGE_SIZE = 40;
const PAGES_PER_BATCH = 5;
const MAX_BATCHES_PER_REQUEST = 20;
const MAX_TMDB_PAGES = 500;
const STATE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const RETRIES = 2;
const IMDB_CACHE_MAX = 30000;

const manifest = {
    id: "cz.flyerscze.animace.tmdb",
    version: "3.0.0",
    name: "🎬 Animace pro děti (TMDB)",
    description: "Animované filmy a seriály pro děti z TMDB. Bez anime a japonských, korejských a čínských titulů.",
    resources: ["catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [
        { type: "movie", id: "deti_filmy_popularni", name: "🧸 Animované filmy: Populární", extra: [{ name: "skip" }] },
        { type: "movie", id: "deti_filmy_nove", name: "🆕 Animované filmy: Nejnovější", extra: [{ name: "skip" }] },
        { type: "series", id: "deti_serialy_popularni", name: "📺 Animované seriály: Populární", extra: [{ name: "skip" }] },
        { type: "series", id: "deti_serialy_nove", name: "🆕 Animované seriály: Nejnovější", extra: [{ name: "skip" }] }
    ]
};

const CATALOGS = {
    deti_filmy_popularni: { type: "movie", kind: "movie", sort: "popularity.desc", minVotes: 20 },
    deti_filmy_nove: { type: "movie", kind: "movie", sort: "primary_release_date.desc", minVotes: 10 },
    deti_serialy_popularni: { type: "series", kind: "tv", sort: "popularity.desc", minVotes: 20 },
    deti_serialy_nove: { type: "series", kind: "tv", sort: "first_air_date.desc", minVotes: 10 }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const IS_V4_TOKEN = TMDB_KEY.length > 40;

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return out;
}

async function tmdb(path, params = {}) {
    const url = new URL(TMDB + path);
    const headers = { Accept: "application/json" };
    if (IS_V4_TOKEN) headers.Authorization = `Bearer ${TMDB_KEY}`;
    else url.searchParams.set("api_key", TMDB_KEY);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    let lastError;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, { headers, signal: controller.signal });
            if (res.status === 404) return null;
            if (res.status === 401) throw Object.assign(new Error("TMDB odmítlo klíč (401)"), { fatal: true });
            if (res.status === 429) {
                const wait = Number(res.headers.get("retry-after")) || 1;
                await sleep(wait * 1000);
                throw new Error("TMDB limit požadavků (429)");
            }
            if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
            return await res.json();
        } catch (error) {
            lastError = error;
            if (error.fatal) throw error;
            if (attempt < RETRIES) await sleep(400 * (attempt + 1));
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastError;
}

const imdbCache = new Map();

async function getImdbId(kind, tmdbId) {
    const key = `${kind}:${tmdbId}`;
    if (imdbCache.has(key)) return imdbCache.get(key);
    let imdb = null;
    try {
        const data = await tmdb(`/${kind}/${tmdbId}/external_ids`);
        imdb = (data && data.imdb_id) || null;
    } catch (error) {
        if (error.fatal) throw error;
        return null;
    }
    if (imdbCache.size >= IMDB_CACHE_MAX) imdbCache.delete(imdbCache.keys().next().value);
    imdbCache.set(key, imdb);
    return imdb;
}

function discoverParams(def, page) {
    const today = new Date().toISOString().slice(0, 10);
    const params = {
        language: LANGUAGE,
        page,
        include_adult: false,
        with_genres: 16,
        sort_by: def.sort,
        without_keywords: EXCLUDE_KEYWORDS,
        "vote_count.gte": def.minVotes
    };
    if (def.kind === "movie") {
        params.certification_country = "US";
        params["certification.lte"] = MAX_RATING;
        params["primary_release_date.lte"] = today;
    } else {
        params.without_genres = EXCLUDE_TV_GENRES;
        params["first_air_date.lte"] = today;
    }
    return params;
}

function isAllowed(item, kind) {
    if (!item || !item.poster_path) return false;
    if (EXCLUDE_LANGS.includes(String(item.original_language || "").toLowerCase())) return false;
    if (kind === "tv") {
        const countries = (item.origin_country || []).map(c => String(c).toUpperCase());
        if (countries.some(c => EXCLUDE_COUNTRIES.includes(c))) return false;
    }
    return true;
}

function toMeta(item, imdbId, type) {
    const date = item.release_date || item.first_air_date || "";
    return {
        id: imdbId,
        type,
        name: item.title || item.name,
        poster: `${IMG}/w342${item.poster_path}`,
        posterShape: "poster",
        background: item.backdrop_path ? `${IMG}/w780${item.backdrop_path}` : undefined,
        description: item.overview || undefined,
        releaseInfo: date ? date.slice(0, 4) : undefined
    };
}

const states = new Map();

function getState(id) {
    let s = states.get(id);
    if (!s || Date.now() - s.created > STATE_TTL_MS) {
        s = { created: Date.now(), items: [], seen: new Set(), nextPage: 1, totalPages: MAX_TMDB_PAGES, done: false, lock: Promise.resolve() };
        states.set(id, s);
    }
    return s;
}

async function loadBatch(state, def) {
    const first = state.nextPage;
    const last = Math.min(first + PAGES_PER_BATCH - 1, state.totalPages);
    const pages = Array.from({ length: last - first + 1 }, (_, i) => first + i);
    const results = await Promise.all(pages.map(p => tmdb(`/discover/${def.kind}`, discoverParams(def, p))));
    const candidates = [];
    for (const r of results) {
        if (!r) continue;
        if (r.total_pages) state.totalPages = Math.min(r.total_pages, MAX_TMDB_PAGES);
        for (const item of r.results || []) if (isAllowed(item, def.kind)) candidates.push(item);
    }
    const imdbIds = await mapLimit(candidates, 10, c => getImdbId(def.kind, c.id));
    candidates.forEach((item, i) => {
        const imdb = imdbIds[i];
        if (!imdb || state.seen.has(imdb)) return;
        state.seen.add(imdb);
        state.items.push(toMeta(item, imdb, def.type));
    });
    state.nextPage = last + 1;
    if (state.nextPage > state.totalPages) state.done = true;
    console.log(`[OK] ${def.kind} stránky ${first}-${last}, celkem ${state.items.length} položek`);
}

function ensure(state, def, needed) {
    const run = state.lock.then(async () => {
        let batches = 0;
        while (state.items.length < needed && !state.done && batches < MAX_BATCHES_PER_REQUEST) {
            await loadBatch(state, def);
            batches++;
        }
    });
    state.lock = run.catch(() => {});
    return run;
}

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    const def = CATALOGS[id];
    if (!def || def.type !== type) return { metas: [] };
    if (!TMDB_KEY) {
        console.error("[CHYBA] Chybí proměnná prostředí TMDB_API_KEY");
        return { metas: [], cacheMaxAge: 60 };
    }
    const skip = Math.max(0, parseInt(extra && extra.skip, 10) || 0);
    console.log(`Požadavek: ${id} skip=${skip}`);
    const state = getState(id);
    let failed = false;
    try {
        await ensure(state, def, skip + PAGE_SIZE);
    } catch (error) {
        failed = true;
        console.error(`[SELHÁNÍ] ${id}: ${error.message}`);
    }
    const metas = state.items.slice(skip, skip + PAGE_SIZE);
    return {
        metas,
        cacheMaxAge: failed && metas.length === 0 ? 60 : 60 * 60,
        staleRevalidate: 24 * 60 * 60,
        staleError: 7 * 24 * 60 * 60
    };
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Doplněk běží na http://localhost:${PORT}/manifest.json`);
if (!TMDB_KEY) console.warn("Upozornění: TMDB_API_KEY není nastaven, katalogy budou prázdné.");
