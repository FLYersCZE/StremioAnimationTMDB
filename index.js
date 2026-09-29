"use strict";

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

// ---------------------------------------------------------------------------
// Nastavení (vše jde přepsat proměnnými prostředí na Renderu)
// ---------------------------------------------------------------------------
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

// Původní jazyky a země, které se vyřadí
const EXCLUDE_LANGS = list(
    process.env.EXCLUDE_LANGS,
    "ja,ko,zh,cn"
).map((s) => s.toLowerCase());

const EXCLUDE_COUNTRIES = list(
    process.env.EXCLUDE_COUNTRIES,
    "JP,KR,CN,TW,HK"
).map((s) => s.toUpperCase());

// TMDB klíčová slova a žánry seriálů, které se vyloučí
// 210024 = anime
// 80 = kriminalita
// 10768 = válka a politika
// 9648 = záhada
const EXCLUDE_KEYWORDS =
    process.env.EXCLUDE_KEYWORDS !== undefined
        ? process.env.EXCLUDE_KEYWORDS
        : "210024";

const EXCLUDE_TV_GENRES =
    process.env.EXCLUDE_TV_GENRES !== undefined
        ? process.env.EXCLUDE_TV_GENRES
        : "80|10768|9648";

// Seriály: výchozí pouze Animace
const TV_GENRES = process.env.TV_GENRES || "16";

const PAGE_SIZE = 40;
const PAGES_PER_BATCH = 5;
const MAX_BATCHES_PER_REQUEST = 20;
const MAX_TMDB_PAGES = 500;
const STATE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const RETRIES = 2;
const IMDB_CACHE_MAX = 30000;

// ---------------------------------------------------------------------------
// Vlastní META / ČSFD
// ---------------------------------------------------------------------------
const META_CACHE_MAX = 10000;
const CZDB_BASE =
    process.env.CZDB_API || "https://api.czdb.cz";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const manifest = {
    id: "cz.flyerscze.animace.tmdb",
    version: "3.1.0",

    name: "🎬 Animace pro děti (TMDB + ČSFD)",

    description:
        "Animované filmy a seriály pro děti z TMDB. " +
        "Bez anime a japonských, korejských a čínských titulů. " +
        "Detail v češtině s ČSFD, pokud je dostupný.",

    resources: [
        "catalog",
        {
            name: "meta",
            types: ["movie", "series"],
            idPrefixes: ["tt"]
        }
    ],

    types: ["movie", "series"],

    idPrefixes: ["tt"],

    catalogs: [
        {
            type: "movie",
            id: "deti_filmy_popularni",
            name: "🧸 Animované filmy: Populární",
            extra: [{ name: "skip" }]
        },

        {
            type: "movie",
            id: "deti_filmy_nove",
            name: "🆕 Animované filmy: Nejnovější",
            extra: [{ name: "skip" }]
        },

        {
            type: "series",
            id: "deti_serialy_popularni",
            name: "📺 Animované seriály: Populární",
            extra: [{ name: "skip" }]
        },

        {
            type: "series",
            id: "deti_serialy_nove",
            name: "🆕 Animované seriály: Nejnovější",
            extra: [{ name: "skip" }]
        }
    ]
};

// ---------------------------------------------------------------------------
// Definice katalogů
// ---------------------------------------------------------------------------
const CATALOGS = {
    deti_filmy_popularni: {
        type: "movie",
        kind: "movie",
        sort: "popularity.desc",
        minVotes: 20
    },

    deti_filmy_nove: {
        type: "movie",
        kind: "movie",
        sort: "primary_release_date.desc",
        minVotes: 10
    },

    deti_serialy_popularni: {
        type: "series",
        kind: "tv",
        sort: "popularity.desc",
        minVotes: 20
    },

    deti_serialy_nove: {
        type: "series",
        kind: "tv",
        sort: "first_air_date.desc",
        minVotes: 10
    }
};

// ---------------------------------------------------------------------------
// Pomocné funkce
// ---------------------------------------------------------------------------
const sleep = (ms) =>
    new Promise((r) => setTimeout(r, ms));

const IS_V4_TOKEN = TMDB_KEY.length > 40;

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;

    const workers = Array.from(
        {
            length: Math.min(
                limit,
                items.length
            )
        },
        async () => {
            while (true) {
                const i = next++;

                if (i >= items.length) {
                    return;
                }

                out[i] = await fn(items[i]);
            }
        }
    );

    await Promise.all(workers);

    return out;
}

// ---------------------------------------------------------------------------
// TMDB request
// ---------------------------------------------------------------------------
async function tmdb(path, params = {}) {
    const url = new URL(TMDB + path);

    const headers = {
        Accept: "application/json"
    };

    if (IS_V4_TOKEN) {
        headers.Authorization =
            `Bearer ${TMDB_KEY}`;
    } else {
        url.searchParams.set(
            "api_key",
            TMDB_KEY
        );
    }

    for (const [k, v] of Object.entries(params)) {
        if (
            v !== undefined &&
            v !== null &&
            v !== ""
        ) {
            url.searchParams.set(
                k,
                String(v)
            );
        }
    }

    let lastError;

    for (
        let attempt = 0;
        attempt <= RETRIES;
        attempt++
    ) {
        const controller =
            new AbortController();

        const timer = setTimeout(
            () => controller.abort(),
            REQUEST_TIMEOUT_MS
        );

        try {
            const res = await fetch(
                url,
                {
                    headers,
                    signal:
                        controller.signal
                }
            );

            if (res.status === 404) {
                return null;
            }

            if (res.status === 401) {
                throw Object.assign(
                    new Error(
                        "TMDB odmítlo klíč (401)"
                    ),
                    {
                        fatal: true
                    }
                );
            }

            if (res.status === 429) {
                const wait =
                    Number(
                        res.headers.get(
                            "retry-after"
                        )
                    ) || 1;

                await sleep(
                    wait * 1000
                );

                throw new Error(
                    "TMDB limit požadavků (429)"
                );
            }

            if (!res.ok) {
                throw new Error(
                    `TMDB HTTP ${res.status}`
                );
            }

            return await res.json();

        } catch (error) {
            lastError = error;

            if (error.fatal) {
                throw error;
            }

            if (
                attempt < RETRIES
            ) {
                await sleep(
                    400 *
                    (attempt + 1)
                );
            }

        } finally {
            clearTimeout(timer);
        }
    }

    throw lastError;
}

// ---------------------------------------------------------------------------
// TMDB ID -> IMDb ID
// ---------------------------------------------------------------------------
const imdbCache = new Map();

async function getImdbId(
    kind,
    tmdbId
) {
    const key =
        `${kind}:${tmdbId}`;

    if (
        imdbCache.has(key)
    ) {
        return imdbCache.get(key);
    }

    let imdb = null;

    try {
        const data =
            await tmdb(
                `/${kind}/${tmdbId}/external_ids`
            );

        imdb =
            (data &&
                data.imdb_id) ||
            null;

    } catch (error) {
        if (error.fatal) {
            throw error;
        }

        return null;
    }

    if (
        imdbCache.size >=
        IMDB_CACHE_MAX
    ) {
        imdbCache.delete(
            imdbCache
                .keys()
                .next()
                .value
        );
    }

    imdbCache.set(
        key,
        imdb
    );

    return imdb;
}

// ---------------------------------------------------------------------------
// TMDB discover parametry
// ---------------------------------------------------------------------------
function discoverParams(
    def,
    page
) {
    const today =
        new Date()
            .toISOString()
            .slice(0, 10);

    const params = {
        language: LANGUAGE,

        page,

        include_adult: false,

        with_genres:
            def.kind === "tv"
                ? TV_GENRES
                : 16,

        sort_by: def.sort,

        without_keywords:
            EXCLUDE_KEYWORDS,

        "vote_count.gte":
            def.minVotes
    };

    if (
        def.kind === "movie"
    ) {
        params.certification_country =
            "US";

        params["certification.lte"] =
            MAX_RATING;

        params[
            "primary_release_date.lte"
        ] = today;

    } else {
        params.without_genres =
            EXCLUDE_TV_GENRES;

        params[
            "first_air_date.lte"
        ] = today;
    }

    return params;
}

// ---------------------------------------------------------------------------
// Kontrola položky
// ---------------------------------------------------------------------------
function isAllowed(
    item,
    kind
) {
    if (
        !item ||
        !item.poster_path
    ) {
        return false;
    }

    if (
        EXCLUDE_LANGS.includes(
            String(
                item.original_language ||
                ""
            ).toLowerCase()
        )
    ) {
        return false;
    }

    if (
        kind === "tv"
    ) {
        const countries =
            (
                item.origin_country ||
                []
            ).map(
                (c) =>
                    String(
                        c
                    ).toUpperCase()
            );

        if (
            countries.some(
                (c) =>
                    EXCLUDE_COUNTRIES.includes(
                        c
                    )
            )
        ) {
            return false;
        }
    }

    return true;
}

// ---------------------------------------------------------------------------
// Katalogová META
// ---------------------------------------------------------------------------
function toMeta(
    item,
    imdbId,
    type
) {
    const date =
        item.release_date ||
        item.first_air_date ||
        "";

    return {
        id: imdbId,

        type,

        name:
            item.title ||
            item.name,

        poster:
            `${IMG}/w342${item.poster_path}`,

        posterShape:
            "poster",

        background:
            item.backdrop_path
                ? `${IMG}/w780${item.backdrop_path}`
                : undefined,

        description:
            item.overview ||
            undefined,

        releaseInfo:
            date
                ? date.slice(0, 4)
                : undefined
    };
}

// ---------------------------------------------------------------------------
// Stav katalogů
// ---------------------------------------------------------------------------
const states =
    new Map();

function getState(id) {
    let s =
        states.get(id);

    if (
        !s ||
        Date.now() -
            s.created >
            STATE_TTL_MS
    ) {
        s = {
            created:
                Date.now(),

            items: [],

            seen:
                new Set(),

            nextPage:
                1,

            totalPages:
                MAX_TMDB_PAGES,

            done:
                false,

            lock:
                Promise.resolve()
        };

        states.set(
            id,
            s
        );
    }

    return s;
}

// ---------------------------------------------------------------------------
// Načtení dávky TMDB
// ---------------------------------------------------------------------------
async function loadBatch(
    state,
    def
) {
    const first =
        state.nextPage;

    const last =
        Math.min(
            first +
                PAGES_PER_BATCH -
                1,

            state.totalPages
        );

    const pages =
        Array.from(
            {
                length:
                    last -
                    first +
                    1
            },
            (_, i) =>
                first + i
        );

    const results =
        await Promise.all(
            pages.map(
                (p) =>
                    tmdb(
                        `/discover/${def.kind}`,
                        discoverParams(
                            def,
                            p
                        )
                    )
            )
        );

    const candidates =
        [];

    for (
        const r of results
    ) {
        if (!r) {
            continue;
        }

        if (
            r.total_pages
        ) {
            state.totalPages =
                Math.min(
                    r.total_pages,
                    MAX_TMDB_PAGES
                );
        }

        for (
            const item of
                r.results || []
        ) {
            if (
                isAllowed(
                    item,
                    def.kind
                )
            ) {
                candidates.push(
                    item
                );
            }
        }
    }

    const imdbIds =
        await mapLimit(
            candidates,
            10,
            (c) =>
                getImdbId(
                    def.kind,
                    c.id
                )
        );

    candidates.forEach(
        (item, i) => {
            const imdb =
                imdbIds[i];

            if (
                !imdb ||
                state.seen.has(
                    imdb
                )
            ) {
                return;
            }

            state.seen.add(
                imdb
            );

            state.items.push(
                toMeta(
                    item,
                    imdb,
                    def.type
                )
            );
        }
    );

    state.nextPage =
        last + 1;

    if (
        state.nextPage >
        state.totalPages
    ) {
        state.done =
            true;
    }

    console.log(
        `[OK] ${def.kind} stránky ${first}-${last}, celkem ${state.items.length} položek`
    );
}

// ---------------------------------------------------------------------------
// Zajištění potřebného počtu položek
// ---------------------------------------------------------------------------
function ensure(
    state,
    def,
    needed
) {
    const run =
        state.lock.then(
            async () => {
                let batches = 0;

                while (
                    state.items.length <
                        needed &&
                    !state.done &&
                    batches <
                        MAX_BATCHES_PER_REQUEST
                ) {
                    await loadBatch(
                        state,
                        def
                    );

                    batches++;
                }
            }
        );

    state.lock =
        run.catch(
            () => {}
        );

    return run;
}

// ---------------------------------------------------------------------------
// META cache
// ---------------------------------------------------------------------------
const metaCache =
    new Map();

function cacheMeta(
    key,
    value
) {
    if (
        metaCache.size >=
        META_CACHE_MAX
    ) {
        metaCache.delete(
            metaCache
                .keys()
                .next()
                .value
        );
    }

    metaCache.set(
        key,
        {
            created:
                Date.now(),

            value
        }
    );
}

function getCachedMeta(
    key
) {
    const entry =
        metaCache.get(key);

    if (!entry) {
        return null;
    }

    if (
        Date.now() -
            entry.created >
            STATE_TTL_MS
    ) {
        metaCache.delete(
            key
        );

        return null;
    }

    return entry.value;
}

// ---------------------------------------------------------------------------
// IMDb -> TMDB
// ---------------------------------------------------------------------------
async function findTmdbByImdb(
    imdbId
) {
    const data =
        await tmdb(
            `/find/${encodeURIComponent(
                imdbId
            )}`,
            {
                external_source:
                    "imdb_id",

                language:
                    LANGUAGE
            }
        );

    if (!data) {
        return null;
    }

    if (
        data.tv_results &&
        data.tv_results.length
    ) {
        return {
            kind: "tv",
            item:
                data.tv_results[0]
        };
    }

    if (
        data.movie_results &&
        data.movie_results.length
    ) {
        return {
            kind: "movie",
            item:
                data.movie_results[0]
        };
    }

    return null;
}

// ---------------------------------------------------------------------------
// Detail TMDB
// ---------------------------------------------------------------------------
async function getTmdbDetail(
    kind,
    tmdbId
) {
    return await tmdb(
        `/${kind}/${tmdbId}`,
        {
            language:
                LANGUAGE,

            append_to_response:
                "credits,external_ids"
        }
    );
}

// ---------------------------------------------------------------------------
// CZDB / ČSFD
// ---------------------------------------------------------------------------
async function getCsfdData(
    imdbId
) {
    const url =
        new URL(
            CZDB_BASE
        );

    url.searchParams.set(
        "i",
        imdbId
    );

    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () =>
                controller.abort(),

            REQUEST_TIMEOUT_MS
        );

    try {
        const res =
            await fetch(
                url,
                {
                    headers: {
                        Accept:
                            "application/json"
                    },

                    signal:
                        controller.signal
                }
            );

        if (!res.ok) {
            throw new Error(
                `CZDB HTTP ${res.status}`
            );
        }

        const data =
            await res.json();

        if (
            !data ||
            data === false
        ) {
            return null;
        }

        return data;

    } catch (error) {
        console.warn(
            `[CZDB] ${imdbId}: ${error.message}`
        );

        return null;

    } finally {
        clearTimeout(
            timer
        );
    }
}

// ---------------------------------------------------------------------------
// Bezpečné hledání hodnot v CZDB odpovědi
// ---------------------------------------------------------------------------
function findFirstValue(
    value,
    wantedKeys,
    depth = 0
) {
    if (
        !value ||
        typeof value !==
            "object" ||
        depth > 4
    ) {
        return null;
    }

    const keys =
        Object.keys(
            value
        );

    for (
        const key of keys
    ) {
        const normalized =
            String(key)
                .toLowerCase()
                .replace(
                    /[_\-\s]/g,
                    ""
                );

        if (
            wantedKeys.includes(
                normalized
            )
        ) {
            const candidate =
                value[key];

            if (
                candidate !==
                    undefined &&
                candidate !==
                    null &&
                candidate !== ""
            ) {
                return candidate;
            }
        }
    }

    for (
        const key of keys
    ) {
        const nested =
            value[key];

        if (
            nested &&
            typeof nested ===
                "object"
        ) {
            const result =
                findFirstValue(
                    nested,
                    wantedKeys,
                    depth + 1
                );

            if (
                result !==
                    undefined &&
                result !==
                    null &&
                result !== ""
            ) {
                return result;
            }
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Normalizace hodnocení
// ---------------------------------------------------------------------------
function normalizeRating(
    value
) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    if (
        typeof value ===
        "number"
    ) {
        return value;
    }

    const text =
        String(value)
            .replace(
                ",",
                "."
            )
            .replace(
                "%",
                ""
            )
            .trim();

    const number =
        Number(text);

    return Number.isFinite(
        number
    )
        ? number
        : null;
}

// ---------------------------------------------------------------------------
// Normalizace ČSFD údajů
// ---------------------------------------------------------------------------
function normalizeCsfdData(
    data
) {
    if (
        !data ||
        typeof data !==
            "object"
    ) {
        return null;
    }

    const rating =
        normalizeRating(
            findFirstValue(
                data,
                [
                    "rating",
                    "hodnoceni",
                    "hodnotenie",
                    "score",
                    "csfdrating"
                ]
            )
        );

    const csfdUrl =
        findFirstValue(
            data,
            [
                "url",
                "csfdurl",
                "link"
            ]
        );

    const description =
        findFirstValue(
            data,
            [
                "description",
                "popis",
                "synopsis",
                "overview"
            ]
        );

    const title =
        findFirstValue(
            data,
            [
                "title",
                "name",
                "nazev",
                "názov"
            ]
        );

    const uid =
        findFirstValue(
            data,
            [
                "uid",
                "csfdid"
            ]
        );

    return {
        rating,
        csfdUrl,
        description,
        title,
        uid
    };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------
const builder =
    new addonBuilder(
        manifest
    );

// ---------------------------------------------------------------------------
// CATALOG HANDLER
// ---------------------------------------------------------------------------
builder.defineCatalogHandler(
    async ({
        type,
        id,
        extra
    }) => {
        const def =
            CATALOGS[id];

        if (
            !def ||
            def.type !== type
        ) {
            return {
                metas: []
            };
        }

        if (!TMDB_KEY) {
            console.error(
                "[CHYBA] Chybí proměnná prostředí TMDB_API_KEY"
            );

            return {
                metas: [],

                cacheMaxAge:
                    60
            };
        }

        const skip =
            Math.max(
                0,
                parseInt(
                    extra &&
                        extra.skip,
                    10
                ) || 0
            );

        console.log(
            `Požadavek: ${id} skip=${skip}`
        );

        const state =
            getState(id);

        let failed =
            false;

        try {
            await ensure(
                state,
                def,
                skip +
                    PAGE_SIZE
            );

        } catch (error) {
            failed =
                true;

            console.error(
                `[SELHÁNÍ] ${id}: ${error.message}`
            );
        }

        const metas =
            state.items.slice(
                skip,
                skip +
                    PAGE_SIZE
            );

        return {
            metas,

            cacheMaxAge:
                failed &&
                metas.length === 0
                    ? 60
                    : 60 * 60,

            staleRevalidate:
                24 * 60 * 60,

            staleError:
                7 * 24 * 60 * 60
        };
    }
);

// ---------------------------------------------------------------------------
// META HANDLER
// ---------------------------------------------------------------------------
builder.defineMetaHandler(
    async ({
        type,
        id
    }) => {

        if (
            !id ||
            !String(id).startsWith(
                "tt"
            ) ||
            (
                type !== "movie" &&
                type !== "series"
            )
        ) {
            return {
                meta: null
            };
        }

        const cacheKey =
            `${type}:${id}`;

        const cached =
            getCachedMeta(
                cacheKey
            );

        if (cached) {
            return {
                meta: cached,

                cacheMaxAge:
                    6 * 60 * 60
            };
        }

        try {

            // ---------------------------------------------------------------
            // 1. IMDb -> TMDB
            // ---------------------------------------------------------------
            const found =
                await findTmdbByImdb(
                    id
                );

            if (!found) {
                console.warn(
                    `[META] TMDB titul nenalezen: ${id}`
                );

                return {
                    meta: null
                };
            }

            // Ověření typu
            if (
                (
                    type === "series" &&
                    found.kind !== "tv"
                ) ||
                (
                    type === "movie" &&
                    found.kind !== "movie"
                )
            ) {
                return {
                    meta: null
                };
            }

            // ---------------------------------------------------------------
            // 2. Plný TMDB detail v češtině
            // ---------------------------------------------------------------
            const detail =
                await getTmdbDetail(
                    found.kind,
                    found.item.id
                );

            if (!detail) {
                return {
                    meta: null
                };
            }

            // ---------------------------------------------------------------
            // 3. CZDB / ČSFD
            // ---------------------------------------------------------------
            const csfdRaw =
                await getCsfdData(
                    id
                );

            const csfd =
                normalizeCsfdData(
                    csfdRaw
                );

            // ---------------------------------------------------------------
            // 4. Popis
            // ---------------------------------------------------------------
            const tmdbDescription =
                detail.overview ||
                found.item.overview ||
                "";

            const csfdDescription =
                csfd &&
                csfd.description
                    ? String(
                        csfd.description
                    )
                    : "";

            const descriptionParts =
                [];

            if (
                csfd &&
                csfd.rating !==
                    null &&
                csfd.rating !==
                    undefined
            ) {
                descriptionParts.push(
                    `⭐ ČSFD: ${csfd.rating} %`
                );

                descriptionParts.push(
                    ""
                );
            }

            if (
                csfdDescription
            ) {
                descriptionParts.push(
                    csfdDescription
                );

            } else if (
                tmdbDescription
            ) {
                descriptionParts.push(
                    tmdbDescription
                );
            }

            // ---------------------------------------------------------------
            // 5. Rok
            // ---------------------------------------------------------------
            const date =
                detail.release_date ||
                detail.first_air_date ||
                found.item.release_date ||
                found.item.first_air_date ||
                "";

            // ---------------------------------------------------------------
            // 6. Žánry
            // ---------------------------------------------------------------
            const genres =
                Array.isArray(
                    detail.genres
                )
                    ? detail.genres
                        .map(
                            (g) =>
                                g &&
                                g.name
                        )
                        .filter(
                            Boolean
                        )
                    : [];

            // ---------------------------------------------------------------
            // 7. Obsazení
            // ---------------------------------------------------------------
            const cast =
                detail.credits &&
                Array.isArray(
                    detail
                        .credits
                        .cast
                )
                    ? detail
                        .credits
                        .cast
                        .slice(
                            0,
                            20
                        )
                        .map(
                            (x) =>
                                x &&
                                x.name
                        )
                        .filter(
                            Boolean
                        )
                    : [];

            // ---------------------------------------------------------------
            // 8. Odkazy
            // ---------------------------------------------------------------
            const links =
                [];

            if (
                csfd &&
                csfd.csfdUrl
            ) {
                links.push({
                    name:
                        "ČSFD",

                    category:
                        "ČSFD",

                    url:
                        String(
                            csfd.csfdUrl
                        )
                });
            }

            links.push({
                name:
                    "IMDb",

                category:
                    "IMDb",

                url:
                    `https://www.imdb.com/title/${id}/`
            });

            // ---------------------------------------------------------------
            // 9. Finální META
            // ---------------------------------------------------------------
            const meta = {

                id,

                type,

                name:
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

                posterShape:
                    "poster",

                background:
                    detail.backdrop_path
                        ? `${IMG}/w1280${detail.backdrop_path}`
                        : undefined,

                description:
                    descriptionParts
                        .join("\n")
                        .trim() ||
                    undefined,

                releaseInfo:
                    date
                        ? date.slice(
                            0,
                            4
                        )
                        : undefined,

                genres,

                cast,

                links
            };

            cacheMeta(
                cacheKey,
                meta
            );

            console.log(
                `[META] OK ${type}/${id}` +
                (
                    csfd
                        ? " + ČSFD"
                        : " bez ČSFD"
                )
            );

            return {
                meta,

                cacheMaxAge:
                    6 * 60 * 60,

                staleRevalidate:
                    24 * 60 * 60,

                staleError:
                    7 * 24 * 60 * 60
            };

        } catch (error) {

            console.error(
                `[META] ${type}/${id}: ${error.message}`
            );

            return {
                meta: null,

                cacheMaxAge:
                    60
            };
        }
    }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
serveHTTP(
    builder.getInterface(),
    {
        port: PORT
    }
);

console.log(
    `Doplněk běží na http://localhost:${PORT}/manifest.json`
);

if (!TMDB_KEY) {
    console.warn(
        "Upozornění: TMDB_API_KEY není nastaven, katalogy budou prázdné."
    );
}
