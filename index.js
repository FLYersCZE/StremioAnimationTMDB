/*
 * Stremio addon: Animace pro děti (TMDB + ČSFD)
 * Version 4.0.0
 *
 * Změna oproti 3.4.1:
 * - český název a český popis z TMDB translations mají přednost,
 * - CZDB/ČSFD český popis má stále nejvyšší prioritu,
 * - angličtina je až poslední nouzová varianta.
 */

"use strict";

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { csfd: csfdApi } = require("node-csfd-api");

const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_API_KEY || "";
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";

const LANGUAGE = process.env.LANGUAGE || "cs-CZ";
const MAX_RATING = process.env.MAX_RATING || "PG";

const list = (value, fallback) =>
    (value === undefined ? fallback : value)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

const EXCLUDE_LANGS = list(process.env.EXCLUDE_LANGS, "ja,ko,zh,cn").map((s) => s.toLowerCase());
const EXCLUDE_COUNTRIES = list(process.env.EXCLUDE_COUNTRIES, "JP,KR,CN,TW,HK").map((s) => s.toUpperCase());

const EXCLUDE_KEYWORDS = process.env.EXCLUDE_KEYWORDS !== undefined
    ? process.env.EXCLUDE_KEYWORDS
    : "210024";

const EXCLUDE_TV_GENRES = process.env.EXCLUDE_TV_GENRES !== undefined
    ? process.env.EXCLUDE_TV_GENRES
    : "80|10768|9648";

const TV_GENRES = process.env.TV_GENRES || "16";

const PAGE_SIZE = 40;
const PAGES_PER_BATCH = 5;
const MAX_BATCHES_PER_REQUEST = 20;
const MAX_TMDB_PAGES = 500;
const STATE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const RETRIES = 2;
const IMDB_CACHE_MAX = 30000;

const META_CACHE_MAX = 10000;
const ADDON_ID_PREFIX = "flyers:";
const CZDB_BASE = process.env.CZDB_API || "https://api.czdb.cz";
const CZDB_TIMEOUT_MS = 4000;
const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const META_SHORT_TTL_MS = 60 * 1000;

const manifest = {
    id: "cz.flyerscze.animace.tmdb",
    version: "4.2.0",
    endpoint: "https://stremioanimationtmdb.onrender.com/manifest.json",
    name: "🎬 Animace pro děti (TMDB + ČSFD)",
    description: "Animované filmy a seriály pro děti z TMDB. Bez anime a japonských, korejských a čínských titulů. Detail v češtině s ČSFD, pokud je dostupný.",
    resources: [
        "catalog",
        {
            name: "meta",
            types: ["movie", "series"],
            idPrefixes: [ADDON_ID_PREFIX]
        }
    ],
    types: ["movie", "series"],
    idPrefixes: [ADDON_ID_PREFIX],
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
        if (v !== undefined && v !== null && v !== "") {
            url.searchParams.set(k, String(v));
        }
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
        with_genres: def.kind === "tv" ? TV_GENRES : 16,
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
        const countries = (item.origin_country || []).map((c) => String(c).toUpperCase());
        if (countries.some((c) => EXCLUDE_COUNTRIES.includes(c))) return false;
    }
    return true;
}

function toMeta(item, imdbId, type) {
    const date = item.release_date || item.first_air_date || "";
    return {
        id: `${ADDON_ID_PREFIX}${imdbId}`,
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
    const results = await Promise.all(
        pages.map((p) => tmdb(`/discover/${def.kind}`, discoverParams(def, p)))
    );

    const candidates = [];
    for (const r of results) {
        if (!r) continue;
        if (r.total_pages) state.totalPages = Math.min(r.total_pages, MAX_TMDB_PAGES);
        for (const item of r.results || []) {
            if (isAllowed(item, def.kind)) candidates.push(item);
        }
    }

    const imdbIds = await mapLimit(candidates, 10, (c) => getImdbId(def.kind, c.id));
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

const metaCache = new Map();

function cacheMeta(key, value, ttl = STATE_TTL_MS) {
    if (metaCache.size >= META_CACHE_MAX) metaCache.delete(metaCache.keys().next().value);
    metaCache.set(key, { created: Date.now(), ttl, value });
}

function getCachedMeta(key) {
    const entry = metaCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.created > entry.ttl) {
        metaCache.delete(key);
        return null;
    }
    return entry.value;
}

async function findTmdbByImdb(imdbId) {
    const data = await tmdb(`/find/${encodeURIComponent(imdbId)}`, {
        external_source: "imdb_id",
        language: LANGUAGE
    });
    if (!data) return null;
    if (data.tv_results && data.tv_results.length) return { kind: "tv", item: data.tv_results[0] };
    if (data.movie_results && data.movie_results.length) return { kind: "movie", item: data.movie_results[0] };
    return null;
}

async function getTmdbDetail(kind, tmdbId) {
    return await tmdb(`/${kind}/${tmdbId}`, {
        language: LANGUAGE,
        append_to_response: "credits,external_ids,translations"
    });
}

// TMDB někdy vrátí překlady odděleně od hlavního language parametru.
// Vždy proto zkusíme najít explicitní českou (cs) variantu.
function getCzechTranslation(detail) {
    const translations =
        detail &&
        detail.translations &&
        Array.isArray(detail.translations.translations)
            ? detail.translations.translations
            : [];

    const candidates = translations.filter(
        (t) => t && String(t.iso_639_1 || "").toLowerCase() === "cs"
    );

    const preferred =
        candidates.find((t) => String(t.iso_3166_1 || "").toUpperCase() === "CZ") ||
        candidates[0];

    if (!preferred || !preferred.data) return null;

    return {
        title: preferred.data.title || preferred.data.name || "",
        overview: preferred.data.overview || ""
    };
}

async function getCsfdData(imdbId) {
    const url = new URL(`${CZDB_BASE}/search`);
    url.searchParams.set("i", imdbId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CZDB_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: controller.signal
        });
        if (!res.ok) throw new Error(`CZDB HTTP ${res.status}`);
        const data = await res.json();
        if (!data || data === false) return null;
        return data;
    } catch (error) {
        console.warn(`[CZDB] ${imdbId}: ${error.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Aktuální ČSFD rating získáváme přes ověřenou knihovnu node-csfd-api.
// CZDB používáme dál pro propojení přes IMDb a pro česká metadata.
async function getCsfdLibraryData(csfdId) {
    if (!csfdId) return null;
    try {
        const data = await csfdApi.movie(String(csfdId));
        if (!data || typeof data !== "object") return null;
        const rating = normalizeRating(data.rating);
        return {
            rating,
            title: data.title || null,
            description: Array.isArray(data.descriptions) && data.descriptions.length
                ? String(data.descriptions[0])
                : null,
            csfdUrl: data.url || null
        };
    } catch (error) {
        console.warn(`[ČSFD API] ${csfdId}: ${error.message}`);
        return null;
    }
}

// CZDB někdy vrací staré nebo nulové hodnocení.
// ČSFD stránka sama obsahuje aktuální hodnotu v .film-rating-average.
async function getDirectCsfdRating(csfdUrl) {
    if (!csfdUrl) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    try {
        const res = await fetch(String(csfdUrl), {
            headers: {
                Accept: "text/html,application/xhtml+xml",
                "User-Agent": "Mozilla/5.0 (compatible; FLYers-StremioAddon/3.6)"
            },
            redirect: "follow",
            signal: controller.signal
        });

        if (!res.ok) throw new Error(`ČSFD HTTP ${res.status}`);

        const html = await res.text();

        // Aktuální ČSFD používá .film-rating-average.
        // Záměrně bereme první hodnotu tohoto prvku, nikoliv jiné procento
        // z textu stránky.
        const patterns = [
            /class=["'][^"']*film-rating-average[^"']*["'][^>]*>\s*([0-9]{1,3})\s*%/i,
            /<[^>]*class=["'][^"']*film-rating-average[^"']*["'][^>]*>\s*([0-9]{1,3})\s*%/i,
            /film-rating-average[^>]*>[\s\S]{0,80}?([0-9]{1,3})\s*%/i
        ];
        let match = null;
        for (const pattern of patterns) {
            match = html.match(pattern);
            if (match) break;
        }
        if (!match) return null;
        const rating = Number(match[1]);
        return Number.isFinite(rating) && rating >= 0 && rating <= 100
            ? rating
            : null;
    } catch (error) {
        console.warn(`[ČSFD WEB] ${csfdUrl}: ${error.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function normalizeRating(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return value;
    const text = String(value).replace(",", ".").replace("%", "").trim();
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
}

function normalizeCsfdData(data) {
    if (!data || typeof data !== "object") return null;

    const item = Array.isArray(data.results) && data.results.length ? data.results[0] : data;
    if (!item || typeof item !== "object") return null;

    const rating = normalizeRating(item.hodnoceni);
    const csfdUrl = item.csfd_url || (item.csfd_id ? `https://www.csfd.cz/film/${item.csfd_id}/` : null);
    const description = item.popis || null;
    const title = item.nazev || item.original || null;
    const uid = item.csfd_id || item.id || null;
    const imdbRating = normalizeRating(item.imdb_hodnoceni);

    return { rating, csfdUrl, description, title, uid, imdbRating, raw: item };
}

async function getCinemetaVideos(imdbId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${CINEMETA_BASE}/meta/series/${imdbId}.json`, {
            headers: { Accept: "application/json" },
            signal: controller.signal
        });
        if (!res.ok) return [];
        const data = await res.json();
        const videos = data && data.meta && data.meta.videos;
        return Array.isArray(videos) ? videos : [];
    } catch (error) {
        console.warn(`[CINEMETA] ${imdbId}: ${error.message}`);
        return [];
    } finally {
        clearTimeout(timer);
    }
}

async function getTmdbVideos(imdbId, detail) {
    const seasons = (detail.seasons || []).filter((s) => s && s.season_number > 0);
    const data = await mapLimit(seasons, 5, (s) =>
        tmdb(`/tv/${detail.id}/season/${s.season_number}`, { language: LANGUAGE }).catch(() => null)
    );
    const videos = [];
    for (const season of data) {
        if (!season) continue;
        for (const ep of season.episodes || []) {
            const released = ep.air_date ? new Date(ep.air_date) : null;
            videos.push({
                id: `${imdbId}:${ep.season_number}:${ep.episode_number}`,
                title: ep.name || `Epizoda ${ep.episode_number}`,
                season: ep.season_number,
                episode: ep.episode_number,
                released: released && !isNaN(released) ? released.toISOString() : undefined,
                overview: ep.overview || undefined,
                thumbnail: ep.still_path ? `${IMG}/w300${ep.still_path}` : undefined
            });
        }
    }
    return videos;
}

async function getSeriesVideos(imdbId, detail) {
    const fromCinemeta = await getCinemetaVideos(imdbId);
    if (fromCinemeta.length) return fromCinemeta;
    return await getTmdbVideos(imdbId, detail);
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

builder.defineMetaHandler(async ({ type, id }) => {
    if (!id || (type !== "movie" && type !== "series")) {
        return { meta: null };
    }

    const rawId = String(id);
    const imdbId = rawId.startsWith(ADDON_ID_PREFIX)
        ? rawId.slice(ADDON_ID_PREFIX.length)
        : rawId;

    if (!imdbId.startsWith("tt")) return { meta: null };

    const cacheKey = `${type}:${rawId}`;
    const cached = getCachedMeta(cacheKey);
    if (cached) {
        return { meta: cached, cacheMaxAge: 6 * 60 * 60 };
    }

    try {
        const found = await findTmdbByImdb(imdbId);
        if (!found) {
            console.warn(`[META] TMDB titul nenalezen: ${id}`);
            return { meta: null };
        }

        if (
            (type === "series" && found.kind !== "tv") ||
            (type === "movie" && found.kind !== "movie")
        ) {
            return { meta: null };
        }

        const detail = await getTmdbDetail(found.kind, found.item.id);
        if (!detail) return { meta: null };

        const [csfdRaw, videos] = await Promise.all([
            getCsfdData(imdbId),
            type === "series" ? getSeriesVideos(imdbId, detail) : Promise.resolve(undefined)
        ]);

        let csfd = normalizeCsfdData(csfdRaw);

        // ČSFD hodnocení bereme přednostně z aktuálních dat ČSFD podle jejího ID.
        // Tím opravíme případy, kdy CZDB vrací 0 nebo zastaralé procento.
        if (csfd && csfd.uid) {
            const liveCsfd = await getCsfdLibraryData(csfd.uid);
            if (liveCsfd && liveCsfd.rating !== null && liveCsfd.rating > 0) {
                csfd.rating = liveCsfd.rating;
            }
            if (liveCsfd && liveCsfd.csfdUrl && !csfd.csfdUrl) {
                csfd.csfdUrl = liveCsfd.csfdUrl;
            }
        }

        // Záložní cesta: pokud knihovna ČSFD rating nezíská, zkusíme přímo HTML stránky.
        if (csfd && csfd.csfdUrl && (!csfd.rating || csfd.rating <= 0)) {
            const directRating = await getDirectCsfdRating(csfd.csfdUrl);
            if (directRating !== null) {
                csfd.rating = directRating;
            }
        }

        const czechTranslation = getCzechTranslation(detail);

        const tmdbDescription =
            (czechTranslation && czechTranslation.overview) ||
            detail.overview ||
            found.item.overview ||
            "";

        const csfdDescription = csfd && csfd.description ? String(csfd.description) : "";
        const descriptionParts = [];

        // ČSFD řádek je vždy na stejném místě a ve stejném formátu:
        // procenta → ikonka → ČSFD. Pokud hodnocení není dostupné,
        // řádek zůstane zachovaný, aby se vzhled jednotlivých titulů nelišil.
        const csfdRatingText =
            csfd && csfd.rating !== null && csfd.rating > 0
                ? `${csfd.rating} %`
                : "— %";
        descriptionParts.push(`${csfdRatingText} 🎬 ČSFD`);
        descriptionParts.push("");

        if (csfdDescription) descriptionParts.push(csfdDescription);
        else if (tmdbDescription) descriptionParts.push(tmdbDescription);

        const date =
            detail.release_date ||
            detail.first_air_date ||
            found.item.release_date ||
            found.item.first_air_date ||
            "";

        const genres = Array.isArray(detail.genres)
            ? detail.genres.map((g) => g && g.name).filter(Boolean)
            : [];

        const cast =
            detail.credits && Array.isArray(detail.credits.cast)
                ? detail.credits.cast.slice(0, 20).map((x) => x && x.name).filter(Boolean)
                : [];

        const links = [];

        if (csfd && csfd.csfdUrl) {
            links.push({
                name: "ČSFD",
                category: "ČSFD",
                url: String(csfd.csfdUrl)
            });
        }

        links.push({
            name: "IMDb",
            category: "IMDb",
            url: `https://www.imdb.com/title/${imdbId}/`
        });

        const meta = {
            id: rawId,
            type,
            name:
                (czechTranslation && czechTranslation.title) ||
                (csfd && csfd.title) ||
                detail.title ||
                detail.name ||
                found.item.title ||
                found.item.name ||
                "Neznámý titul",
            poster:
                detail.poster_path
                    ? `${IMG}/w500${detail.poster_path}`
                    : found.item.poster_path
                        ? `${IMG}/w500${found.item.poster_path}`
                        : undefined,
            posterShape: "poster",
            background:
                detail.backdrop_path
                    ? `${IMG}/w1280${detail.backdrop_path}`
                    : undefined,
            description:
                descriptionParts.join("\n").trim() ||
                undefined,
            releaseInfo: date ? date.slice(0, 4) : undefined,
            genres,
            cast,
            links,
            imdbRating: csfd && csfd.imdbRating !== null && csfd.imdbRating !== undefined
                ? String(csfd.imdbRating)
                : undefined,
            videos,
            behaviorHints: type === "movie"
                ? { defaultVideoId: imdbId }
                : undefined
        };

        cacheMeta(cacheKey, meta, META_SHORT_TTL_MS);

        console.log(
            `[META] OK ${type}/${rawId}` +
            (csfd ? ` + ČSFD ${csfd.rating || 0}%` : " bez ČSFD")
        );

        return {
            meta,
            cacheMaxAge: 60,
            staleRevalidate: 60,
            staleError: 24 * 60 * 60
        };
    } catch (error) {
        console.error(`[META] ${type}/${rawId}: ${error.message}`);
        return { meta: null, cacheMaxAge: 60 };
    }
});

serveHTTP(builder.getInterface(), { port: PORT });

console.log(`Doplněk běží na http://localhost:${PORT}/manifest.json`);

if (!TMDB_KEY) {
    console.warn("Upozornění: TMDB_API_KEY není nastaven, katalogy budou prázdné.");
}
