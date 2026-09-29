"use strict";

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_API_KEY || "";
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const CINEMETA_BASE = process.env.CINEMETA_BASE || "https://v3-cinemeta.strem.io";
const LANGUAGE = process.env.LANGUAGE || "cs-CZ";
const MAX_RATING = process.env.MAX_RATING || "PG";
const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

const log = (...args) => { if (DEBUG) console.log(...args); };
const warn = (...args) => console.warn(...args);
const error = (...args) => console.error(...args);

const list = (value, fallback) =>
    (value === undefined ? fallback : value).split(",").map(s => s.trim()).filter(Boolean);

const EXCLUDE_LANGS = list(process.env.EXCLUDE_LANGS, "ja,ko,zh,cn").map(s => s.toLowerCase());
const EXCLUDE_COUNTRIES = list(process.env.EXCLUDE_COUNTRIES, "JP,KR,CN,TW,HK").map(s => s.toUpperCase());
const EXCLUDE_KEYWORDS = process.env.EXCLUDE_KEYWORDS !== undefined ? process.env.EXCLUDE_KEYWORDS : "210024";
const EXCLUDE_TV_GENRES = process.env.EXCLUDE_TV_GENRES !== undefined ? process.env.EXCLUDE_TV_GENRES : "80|10768|9648";

const PAGE_SIZE = 40;
const PAGES_PER_BATCH = 5;
const MAX_BATCHES_PER_REQUEST = 8;
const MAX_TMDB_PAGES = 500;
const STATE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const PREHRAJTO_TIMEOUT_MS = 5000;
const CZ_DABING_CANDIDATES = 20;
const CZ_DABING_CONCURRENCY = 12;
const PREHRAJTO_USERNAME = process.env.PREHRAJTO_USERNAME || "";
const PREHRAJTO_PASSWORD = process.env.PREHRAJTO_PASSWORD || "";
const CZ_DABING_CACHE_MAX = 5000;
const CZ_DABING_TTL_MS = 6 * 60 * 60 * 1000;
const RETRIES = 2;
const IMDB_CACHE_MAX = 30000;
const OVERVIEW_CACHE_MAX = 5000;
const OVERVIEW_TTL_MS = 12 * 60 * 60 * 1000;

const manifest = {
    id: "cz.flyerscze.animace.tmdb",
    version: "3.1.0",
    name: "🎬 Animace pro děti (TMDB)",
    description: "Animované filmy a seriály pro děti z TMDB. Bez anime a japonských, korejských a čínských titulů.",
    resources: [
        "catalog",
        "stream",
        { name: "meta", types: ["movie", "series"], idPrefixes: ["tt"] }
    ],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    behaviorHints: { configurable: false },
    catalogs: [
        { type: "movie", id: "deti_filmy_nove", name: "🆕 Animované filmy: Nejnovější", extra: [{ name: "skip" }] },
        { type: "movie", id: "deti_filmy_cz_dabing", name: "🇨🇿 Animované filmy: Český dabing", extra: [{ name: "skip" }] },
        { type: "movie", id: "deti_filmy_popularni", name: "🧸 Animované filmy: Populární", extra: [{ name: "skip" }] },
        { type: "series", id: "deti_serialy_nove", name: "🆕 Animované seriály: Nejnovější", extra: [{ name: "skip" }] },
        { type: "series", id: "deti_serialy_popularni", name: "📺 Animované seriály: Populární", extra: [{ name: "skip" }] }
    ]
};

const CATALOGS = {
    deti_filmy_popularni: { type: "movie", kind: "movie", sort: "popularity.desc", minVotes: 30 },
    deti_filmy_nove: { type: "movie", kind: "movie", sort: "primary_release_date.desc", minVotes: 20 },
    deti_filmy_cz_dabing: { type: "movie", kind: "movie", sort: "primary_release_date.desc", minVotes: 10 },
    deti_serialy_popularni: { type: "series", kind: "tv", sort: "popularity.desc", minVotes: 30 },
    deti_serialy_nove: { type: "series", kind: "tv", sort: "first_air_date.desc", minVotes: 20 }
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
        } catch (err) {
            lastError = err;
            if (err.fatal) throw err;
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
    } catch (err) {
        if (err.fatal) throw err;
        return null;
    }
    if (imdbCache.size >= IMDB_CACHE_MAX) imdbCache.delete(imdbCache.keys().next().value);
    imdbCache.set(key, imdb);
    return imdb;
}

const overviewCache = new Map();

function overviewGet(key) {
    const entry = overviewCache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.exp) { overviewCache.delete(key); return undefined; }
    return entry.value;
}

function overviewSet(key, value) {
    if (overviewCache.size >= OVERVIEW_CACHE_MAX) overviewCache.delete(overviewCache.keys().next().value);
    overviewCache.set(key, { value, exp: Date.now() + OVERVIEW_TTL_MS });
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
        s = {
            created: Date.now(),
            items: [],
            seen: new Set(),
            nextPage: 1,
            totalPages: MAX_TMDB_PAGES,
            done: false,
            fatal: false,
            lock: Promise.resolve()
        };
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
    log(`[OK] ${def.kind} stránky ${first}-${last}, celkem ${state.items.length} položek`);
}

function ensure(state, def, needed) {
    if (state.fatal) return Promise.resolve();
    const run = state.lock.then(async () => {
        if (state.fatal) return;
        let batches = 0;
        while (state.items.length < needed && !state.done && batches < MAX_BATCHES_PER_REQUEST) {
            await loadBatch(state, def);
            batches++;
        }
    });
    state.lock = run.catch(err => {
        if (err && err.fatal) {
            state.fatal = true;
            error(`[FATAL] ${def.kind}: ${err.message}`);
        }
    });
    return run;
}


const czDabingCache = new Map();

function czDabingCacheGet(key) {
    const entry = czDabingCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.created > CZ_DABING_TTL_MS) {
        czDabingCache.delete(key);
        return undefined;
    }
    return entry.value;
}

function czDabingCacheSet(key, value) {
    if (czDabingCache.size >= CZ_DABING_CACHE_MAX) {
        czDabingCache.delete(czDabingCache.keys().next().value);
    }
    czDabingCache.set(key, { created: Date.now(), value });
}

function hasCzechDubbingTitle(title) {
    const text = String(title || "")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
        .toLowerCase();

    // Pouze skutečný dabing. Samotné "CZ" nestačí a české titulky nejsou dabing.
    if (/(?:cz|cze)[\s._-]*titulky|česk(?:é|e)\s*titulky/.test(text)) return false;
    if (/(?:^|[\s._\-\[\](){}])(?:cz|cze)[\s._\-:]*dab(?:ing|bed|ín)?(?:[\s._\-\[\](){}]|$)/.test(text)) return true;
    if (/česk(?:ý|y|á|é)\s*(?:dab(?:ing|bed|ín)?|znění)/.test(text)) return true;
    return false;
}

let prehrajtoCookies = null;
let prehrajtoCookiesAt = 0;

function extractSetCookies(headers) {
    if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
    const one = headers.get("set-cookie");
    return one ? [one] : [];
}

function cookieHeader(setCookies) {
    return setCookies
        .map(v => String(v).split(";", 1)[0])
        .filter(Boolean)
        .join("; ");
}

async function getPrehrajtoHeaders() {
    const common = {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        Cookie: "AC=C",
        Referer: "https://prehraj.to/",
        "Referrer-Policy": "strict-origin-when-cross-origin"
    };

    // Stejně jako CzStreams nejdřív otevřeme PřeHraj.to anonymně a získáme
    // jeho session cookies. Ty jsou potřeba i bez uživatelského účtu.
    if (prehrajtoCookies && Date.now() - prehrajtoCookiesAt < 8_400_000) {
        return { ...common, Cookie: prehrajtoCookies };
    }

    const home = await fetch("https://prehraj.to/", {
        headers: common,
        method: "GET"
    });
    const initial = cookieHeader(extractSetCookies(home.headers));
    let combined = initial;

    if (PREHRAJTO_USERNAME && PREHRAJTO_PASSWORD) {
        const form = new URLSearchParams();
        form.set("email", PREHRAJTO_USERNAME);
        form.set("password", PREHRAJTO_PASSWORD);
        form.set("remember_login", "on");
        form.set("_do", "loginDialog-login-loginForm-submit");
        form.set("login", "Přihlásit se");

        const login = await fetch("https://prehraj.to/?frm=loginDialog-login-loginForm", {
            method: "POST",
            headers: {
                ...common,
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                ...(initial ? { Cookie: initial } : {})
            },
            body: form.toString()
        });

        const cookies = extractSetCookies(login.headers);
        combined = cookieHeader([
            ...(initial ? initial.split(/;\s*/) : []),
            ...cookies
        ]);
    }

    if (combined) {
        prehrajtoCookies = combined;
        prehrajtoCookiesAt = Date.now();
    }
    return combined ? { ...common, Cookie: combined } : common;
}

function decodeHtml(value) {
    return String(value || "")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/&nbsp;/gi, " ")
        .replace(/&#([0-9]+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractVideoTitles(html) {
    const titles = [];
    for (const match of String(html || "").matchAll(/<a\b([^>]*class=["'][^"']*\bvideo--link\b[^"']*["'][^>]*)>/gi)) {
        const titleMatch = match[1].match(/\btitle=["']([^"']*)["']/i);
        if (titleMatch) titles.push(decodeHtml(titleMatch[1]).trim());
    }
    return titles;
}

function extractVideoResults(html) {
    const results = [];
    for (const match of String(html || "").matchAll(/<a\b([^>]*class=["'][^"']*\bvideo--link\b[^"']*["'][^>]*)>/gi)) {
        const attrs = match[1];
        const titleMatch = attrs.match(/\btitle=["']([^"']*)["']/i);
        const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
        if (titleMatch && hrefMatch) {
            results.push({ title: decodeHtml(titleMatch[1]).trim(), href: hrefMatch[1] });
        }
    }
    return results;
}

async function prehrajtoSearchResults(query, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREHRAJTO_TIMEOUT_MS);
    try {
        const url = `https://prehraj.to/hledej/${encodeURIComponent(query)}?vp-page=0`;
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) return null;
        return extractVideoResults(await res.text());
    } catch (err) {
        log(`[CZ-DABING] search: ${err.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function prehrajtoResolveVideo(path, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREHRAJTO_TIMEOUT_MS);
    try {
        const url = path.startsWith("http") ? path : `https://prehraj.to${path}`;
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) return null;
        const html = await res.text();
        const m = html.match(/var\s+sources\s*=\s*(\[[\s\S]*?\])\s*;/i);
        if (m) {
            try {
                const items = Function("return " + m[1])();
                const video = Array.isArray(items) && items.length ? items[items.length - 1].file : null;
                if (video) return video;
            } catch {}
        }
        const fallback = html.match(/src:\s*["'](https?:\/\/[^"']+)["']/i);
        return fallback ? fallback[1] : null;
    } catch (err) {
        log(`[CZ-DABING] resolve: ${err.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function prehrajtoSearchTitles(query, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREHRAJTO_TIMEOUT_MS);
    try {
        const url = `https://prehraj.to/hledej/${encodeURIComponent(query)}?vp-page=0`;
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) {
            log(`[CZ-DABING] "${query}": PřeHraj.to HTTP ${res.status}`);
            return null;
        }
        const html = await res.text();
        return extractVideoTitles(html);
    } catch (err) {
        log(`[CZ-DABING] "${query}": ${err.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function prehrajtoHasCzechDubbing(title, year, quick = false) {
    const key = String(title).toLowerCase() + "|" + (year || "") + "|" + (quick ? "q" : "f");
    const cached = czDabingCacheGet(key);
    if (cached !== undefined) return cached;

    try {
        const headers = await getPrehrajtoHeaders();
        const queries = quick ? [title] : (year ? [title + " " + year, title] : [title]);
        let anySuccess = false;

        for (const query of queries) {
            const titles = await prehrajtoSearchTitles(query, headers);
            if (titles === null) continue;
            anySuccess = true;
            const result = titles.some(hasCzechDubbingTitle);
            log("[CZ-DABING] " + title + ": " + (result ? "ANO" : "NE") + " přes \"" + query + "\" (" + titles.slice(0, 5).join(" | ") + ")");
            if (result) {
                czDabingCacheSet(key, true);
                return true;
            }
        }

        if (anySuccess) czDabingCacheSet(key, false);
        return false;
    } catch (err) {
        log("[CZ-DABING] " + title + ": " + err.message);
        return false;
    }
}

const builder = new addonBuilder(manifest);

async function getCzechOverview(imdbId, type) {
    if (!TMDB_KEY || !imdbId) return null;

    const cached = overviewGet(imdbId);
    if (cached !== undefined) return cached;

    let result = null;
    try {
        const found = await tmdb(`/find/${encodeURIComponent(imdbId)}`, {
            external_source: "imdb_id",
            language: LANGUAGE
        });

        const item = type === "movie"
            ? (found && found.movie_results && found.movie_results[0])
            : (found && found.tv_results && found.tv_results[0]);

        if (item && item.id) {
            const detailPath = type === "movie" ? `/movie/${item.id}` : `/tv/${item.id}`;
            const detail = await tmdb(detailPath, {
                language: LANGUAGE,
                append_to_response: "translations"
            });

            if (detail && detail.overview && detail.overview.trim()) {
                result = detail.overview.trim();
            } else {
                const translations = detail && detail.translations && detail.translations.translations;
                if (Array.isArray(translations)) {
                    const cs = translations.find(t =>
                        t && t.iso_639_1 === "cs" &&
                        (!t.iso_3166_1 || t.iso_3166_1 === "CZ") &&
                        t.data && t.data.overview
                    );
                    if (cs && cs.data.overview.trim()) result = cs.data.overview.trim();
                }
            }

            if (!result && item.overview && item.overview.trim()) {
                result = item.overview.trim();
            }
        }
    } catch (err) {
        if (err.fatal) throw err;
        log(`[CZ-OVERVIEW] ${imdbId}: ${err.message}`);
        return null;
    }

    overviewSet(imdbId, result);
    return result;
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    const def = CATALOGS[id];
    if (!def || def.type !== type) return { metas: [] };
    if (!TMDB_KEY) {
        error("[CHYBA] Chybí proměnná prostředí TMDB_API_KEY");
        return { metas: [], cacheMaxAge: 60 };
    }
    const skip = Math.max(0, parseInt(extra && extra.skip, 10) || 0);
    log(`Požadavek: ${id} skip=${skip}`);
    if (id === "deti_filmy_cz_dabing") {
        // Tento katalog je záměrně úplně stejný jako „Nejnovější“.
        // Ověření CZ dabingu se provede až po otevření konkrétního filmu
        // ve stream handleru, takže katalog se nikdy nezasekne na PřeHraj.to.
        const state = getState("deti_filmy_nove");
        try {
            await ensure(state, CATALOGS.deti_filmy_nove, skip + PAGE_SIZE);
            return {
                metas: state.items.slice(skip, skip + PAGE_SIZE),
                cacheMaxAge: 60 * 60,
                staleRevalidate: 24 * 60 * 60,
                staleError: 7 * 24 * 60 * 60
            };
        } catch (err) {
            error("[CZ-DABING] " + id + ": " + err.message);
            return { metas: [], cacheMaxAge: 60 };
        }
    }

    const state = getState(id);
    let failed = false;
    try {
        await ensure(state, def, skip + PAGE_SIZE);
    } catch (err) {
        failed = true;
        error(`[SELHÁNÍ] ${id}: ${err.message}`);
    }
    const metas = state.items.slice(skip, skip + PAGE_SIZE);
    return {
        metas,
        cacheMaxAge: failed && metas.length === 0 ? 60 : 60 * 60,
        staleRevalidate: 24 * 60 * 60,
        staleError: 7 * 24 * 60 * 60
    };
});

builder.defineStreamHandler(async ({ type, id }) => {
    try {
        if (type !== "movie" || !id || !id.startsWith("tt")) return { streams: [] };

        const cinemetaUrl = `${CINEMETA_BASE}/meta/${type}/${encodeURIComponent(id)}.json`;
        const metaRes = await fetch(cinemetaUrl);
        if (!metaRes.ok) return { streams: [] };
        const metaData = await metaRes.json();
        const title = metaData && metaData.meta && metaData.meta.name;
        if (!title) return { streams: [] };

        const headers = await getPrehrajtoHeaders();
        const results = await prehrajtoSearchResults(title, headers);
        if (!results) return { streams: [] };

        // Tady se provádí skutečný filtr. Dítě se k tomuto ověření dostane
        // až po otevření filmu; katalog předem nic nekontroluje.
        const czResults = results.filter(item => hasCzechDubbingTitle(item.title));
        if (!czResults.length) {
            log(`[CZ-DABING] ${title}: žádný CZ dabing`);
            return { streams: [] };
        }

        const resolved = [];
        for (const item of czResults.slice(0, 5)) {
            const video = await prehrajtoResolveVideo(item.href, headers);
            if (video) {
                resolved.push({
                    url: video,
                    name: "🇨🇿 PřeHraj.to",
                    description: item.title,
                    behaviorHints: { filename: item.title, bingeGroup: "prehrajto-cz" }
                });
            }
        }

        return { streams: resolved, cacheMaxAge: 6 * 60 * 60 };
    } catch (err) {
        error(`[STREAM-CZ] ${type}/${id}: ${err.message}`);
        return { streams: [] };
    }
});

builder.defineMetaHandler(async ({ type, id }) => {
    try {
        const cinemetaUrl = `${CINEMETA_BASE}/meta/${type}/${encodeURIComponent(id)}.json`;
        const res = await fetch(cinemetaUrl);
        if (!res.ok) return {};

        const data = await res.json();
        const meta = data && data.meta ? { ...data.meta } : {};
        if (!meta.id) meta.id = id;
        if (!meta.type) meta.type = type;

        const czechOverview = await getCzechOverview(id, type);
        if (czechOverview) meta.description = czechOverview;

        return {
            meta,
            cacheMaxAge: 60 * 60,
            staleRevalidate: 24 * 60 * 60,
            staleError: 7 * 24 * 60 * 60
        };
    } catch (err) {
        error(`[META] ${type}/${id}: ${err.message}`);
        return {};
    }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Doplněk běží na http://localhost:${PORT}/manifest.json`);
if (!TMDB_KEY) warn("Upozornění: TMDB_API_KEY není nastaven, katalogy budou prázdné.");