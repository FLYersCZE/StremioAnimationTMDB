// Stávající kód beze změny až po konstanty:

const MAX_SIZE_GB = Number(process.env.MAX_SIZE_GB) || 10;
const MAX_SIZE_BYTES = MAX_SIZE_GB * 1024 * 1024 * 1024;

// ... (vše ostatní beze změny až k prehrajtoResolveVideo)

async function prehrajtoGetSize(url, headers) {
    try {
        const head = await fetch(url, { method: "HEAD", headers });
        if (!head.ok) return null;
        const len = head.headers.get("content-length");
        if (!len) return null;
        const bytes = parseInt(len, 10);
        return Number.isFinite(bytes) ? bytes : null;
    } catch (err) {
        log(`[STREAM-CZ] HEAD selhal: ${err.message}`);
        return null;
    }
}

// V defineStreamHandler nahraď blok s resolve:

        const proxyHeaders = prehrajtoProxyHeaders();
        const resolved = [];

        for (const item of czResults.slice(0, STREAM_RESOLVE_LIMIT)) {
            const video = await prehrajtoResolveVideo(item.href, headers);
            if (!video) continue;

            // Zjisti velikost souboru přes HEAD request
            const sizeBytes = await prehrajtoGetSize(video, headers);
            const sizeGB = sizeBytes ? (sizeBytes / (1024 * 1024 * 1024)).toFixed(2) : "?";
            const sizeLabel = sizeBytes ? `${sizeGB} GB` : "neznámá velikost";
            log(`[STREAM-CZ]   → ${sizeLabel}: ${item.title}`);

            if (sizeBytes && sizeBytes > MAX_SIZE_BYTES) {
                log(`[STREAM-CZ]   ⊘ přeskočeno (> ${MAX_SIZE_GB} GB)`);
                continue;
            }

            resolved.push({
                url: video,
                name: "🇨🇿 PřeHraj.to",
                description: item.title,
                behaviorHints: {
                    filename: item.title,
                    bingeGroup: "prehrajto-cz",
                    proxyHeaders
                }
            });
        }
