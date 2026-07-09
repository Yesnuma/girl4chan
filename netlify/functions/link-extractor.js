const fetch = require('node-fetch');

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── ScraperAPI fallback ──────────────────────────────────────────────
// Only used when a direct fetch is blocked (403/401/429). Sites that work
// directly (eBay via API, Poshmark) never touch the proxy, so credits are
// spent only on genuinely-blocked sites (Etsy, Depop).
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;

function proxiedUrl(targetUrl) {
    // premium=true uses residential IPs — needed because these sites block
    // datacenter IPs (which is the whole problem). No render=true: the og tags
    // live in the server-rendered HTML, so we don't need JS execution, which
    // keeps it fast (under Netlify's timeout) and cheap (fewer credits).
    return 'https://api.scraperapi.com/?api_key=' + SCRAPER_API_KEY +
           '&url=' + encodeURIComponent(targetUrl) +
           '&premium=true&country_code=us';
}

// The proxy is reserved for Etsy — the one site where it's reliably fast.
const PROXY_ALLOWED = ['etsy.com'];

// Fetch directly; if blocked and the domain is proxy-allowed, retry via ScraperAPI.
// Returns { status, html, finalUrl, viaProxy }. html is null on hard failure.
async function smartFetch(targetUrl, timeout = 5000) {
    let status = 'ERR';

    try {
        const res = await fetch(targetUrl, {
            method: 'GET', redirect: 'follow',
            headers: {
                'User-Agent': DESKTOP_UA,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: AbortSignal.timeout(timeout)
        });
        status = res.status;
        if (res.ok) {
            return { status, html: await res.text(), finalUrl: res.url, viaProxy: false };
        }
    } catch (e) {
        console.error('Direct fetch error for', targetUrl, '-', e.message);
    }

    // Blocked/errored — proxy retry, Etsy only
    if (SCRAPER_API_KEY && PROXY_ALLOWED.some(d => targetUrl.includes(d)) && (status === 403 || status === 401 || status === 429 || status === 'ERR')) {
        console.log('Direct fetch got', status, '— retrying via ScraperAPI:', targetUrl);
        try {
            const pRes = await fetch(proxiedUrl(targetUrl), { signal: AbortSignal.timeout(8000) });
            console.log('ScraperAPI status:', pRes.status);
            if (pRes.ok) {
                return { status: pRes.status, html: await pRes.text(), finalUrl: targetUrl, viaProxy: true };
            }
            return { status: pRes.status, html: null, finalUrl: targetUrl, viaProxy: true };
        } catch (e) {
            console.error('ScraperAPI fetch error:', e.message);
            return { status: 'PROXY_ERR', html: null, finalUrl: targetUrl, viaProxy: true };
        }
    }

    return { status, html: null, finalUrl: targetUrl, viaProxy: false };
}
// ─────────────────────────────────────────────────────────────────────

async function getEbayToken() {
    const credentials = Buffer.from(
        `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
    ).toString('base64');

    const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
    });

    const data = await res.json();
    return data.access_token;
}

async function fetchEbayItem(url) {
    const itemIdMatch = url.match(/\/itm\/(?:[^/]+\/)?(\d+)/) ||
                        url.match(/item=(\d+)/) ||
                        url.match(/\/(\d{10,13})(?:\?|$)/);
    if (!itemIdMatch) return null;

    const itemId = itemIdMatch[1];
    const token = await getEbayToken();

    const res = await fetch(`https://api.ebay.com/buy/browse/v1/item/v1|${itemId}|0`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
        }
    });
    if (!res.ok) return null;

    const data = await res.json();
    return {
        image: data.image?.imageUrl || data.additionalImages?.[0]?.imageUrl || null,
        title: data.title || null,
        price: data.price?.value || null,
        description: data.shortDescription || null
    };
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let url;
    try {
        url = JSON.parse(event.body).url;
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }
    if (!url) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No URL provided' }) };
    }

    const urlMatch = url.match(/https?:\/\/[^\s]+/);
    if (urlMatch) url = urlMatch[0];

    let finalUrl = url;
    let prefetchedHtml = null;
    const isShortEbayUrl = url.includes('ebay.us') || url.includes('ebay.to') || url.includes('ebay.io') || url.includes('rover.ebay.com');
    const isBranchLink = url.includes('app.link');

    // Resolve short eBay redirects (not blocked — direct fetch, keep the HTML to reuse)
    if (isShortEbayUrl) {
        try {
            const res = await fetch(url, {
                method: 'GET', redirect: 'follow',
                headers: { 'User-Agent': DESKTOP_UA },
                signal: AbortSignal.timeout(6000)
            });
            finalUrl = res.url;
            prefetchedHtml = await res.text();
            console.log('Resolved short eBay URL:', finalUrl);
        } catch (e) {
            console.error('eBay URL resolution failed:', e.message);
        }
    }

    // Branch deep links (Depop, Grailed, and other app share links)
    // Strategy: the interstitial page itself carries the listing image + real URL,
    // so ONE direct fetch (with browser disguises) is the whole job. No proxy,
    // no second scrape of the (hard-blocked) store site.
    if (isBranchLink) {
        try {
            const UA_DISGUISES = [
                { // iPhone Safari — what Branch expects from a shared link tap
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                { // desktop Chrome fallback
                    'User-Agent': DESKTOP_UA,
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://www.google.com/'
                }
            ];
            let html = '';
            for (const headers of UA_DISGUISES) {
                try {
                    const res = await fetch(url, {
                        method: 'GET', redirect: 'follow', headers,
                        signal: AbortSignal.timeout(4500)
                    });
                    console.log('Branch direct fetch:', url, '-> status', res.status);
                    if (res.ok) { html = await res.text(); break; }
                } catch (e) {
                    console.error('Branch direct attempt failed:', e.message);
                }
            }

            // pull the listing IMAGE straight off the interstitial
            if (html) {
                const branchImage =
                    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1] ||
                    html.replace(/\\//g, '/').match(/https?:\/\/media-assets\.grailed\.com\/[^"'\s<>]+/i)?.[0] ||
                    html.replace(/\\//g, '/').match(/https?:\/\/media-photos\.depop\.com\/[^"'\s<>]+/i)?.[0];
                if (branchImage) {
                    // resolve the real listing URL for the shop link when findable
                    const un = html.replace(/\\//g, '/');
                    let dest =
                        un.match(/https?:\/\/(?:www\.)?grailed\.com\/listings\/\d+/i)?.[0] ||
                        un.match(/https?:\/\/(?:www\.)?depop\.com\/products\/[^?"\s'&<]+/i)?.[0] ||
                        null;
                    if (dest) dest = dest.replace(/([?&])_branch_match_id=[^&]*/, '').replace(/[?&]$/, '');
                    console.log('Branch image found directly. Link:', dest || url);
                    return {
                        statusCode: 200,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                        body: JSON.stringify({
                            image: branchImage.replace(/&amp;/g, '&'),
                            title: null, price: null, description: null,
                            _resolved: dest || url, _viaProxy: false
                        })
                    };
                }
                console.warn('Branch page fetched but no image found. HTML length:', html.length);
            }

            const unescaped = html.replace(/\\\//g, '/');
            const unescaped2 = html.replace(/\\\//g, '/');

            let destination = null;

            // Depop patterns
            const slugMatch = unescaped2.match(/depop\.app\.link\/(?:null)?products?\/([^?"\s'&<]+)/i);
            if (slugMatch && slugMatch[1]) {
                destination = `https://www.depop.com/products/${slugMatch[1]}/`;
            }
            if (!destination) {
                const direct = unescaped2.match(/https?:\/\/(?:www\.)?depop\.com\/products\/[^?"\s'&<]+/i)?.[0];
                if (direct) destination = direct;
            }

            // Grailed pattern: the interstitial embeds the listing URL
            if (!destination) {
                const grailed = unescaped2.match(/https?:\/\/(?:www\.)?grailed\.com\/listings\/(\d+)/i);
                if (grailed && grailed[1]) {
                    destination = `https://www.grailed.com/listings/${grailed[1]}`;
                }
            }

            // Generic Branch fallbacks: $desktop_url / $canonical_url / al:web:url
            if (!destination) {
                const desktop = unescaped2.match(/\$desktop_url["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1] ||
                                unescaped2.match(/\$canonical_url["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1];
                if (desktop && !desktop.includes('app.link')) destination = desktop;
            }
            if (!destination) {
                const meta = html.match(/<meta[^>]+property=["']al:web:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
                if (meta && !meta.includes('app.link')) destination = meta;
            }

            if (destination && !destination.includes('app.link')) {
                // strip branch tracking params
                destination = destination.replace(/([?&])_branch_match_id=[^&]*/,'$1').replace(/([?&])_branch_referrer=[^&]*/,'$1').replace(/[?&]$/, '');
                finalUrl = destination;
                console.log('Branch link resolved to:', finalUrl);
            } else {
                console.warn('Branch link did NOT resolve to a product. HTML length:', html.length);
            }
        } catch (e) {
            console.error('Branch resolution failed:', e.message);
        }
    }

    // eBay API path (never uses the proxy)
    const isEbay = finalUrl.includes('ebay.com') || finalUrl.includes('ebay.us') || finalUrl.includes('ebay.io') || url.includes('ebay.com') || url.includes('ebay.us') || url.includes('ebay.io');
    if (isEbay) {
        try {
            const ebayData = await fetchEbayItem(finalUrl);
            if (ebayData) {
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                    body: JSON.stringify({ ...ebayData, _resolved: finalUrl })
                };
            }
        } catch (e) {
            console.error('eBay API error:', e);
        }
    }

    // Scrape og tags. smartFetch handles the 403 -> proxy retry for blocked sites.
    try {
        let html, viaProxy = false, status = 200;
        if (prefetchedHtml) {
            html = prefetchedHtml;
            console.log('Scrape: reusing prefetched HTML for', finalUrl);
        } else {
            const r = await smartFetch(finalUrl, 5000);
            viaProxy = r.viaProxy;
            status = r.status;
            console.log('Scrape:', finalUrl, '-> status', status, viaProxy ? '(via proxy)' : '(direct)');
            if (!r.html) {
                return { statusCode: 200, body: JSON.stringify({ error: `Could not fetch page (${status})`, _resolved: finalUrl, _viaProxy: viaProxy }) };
            }
            html = r.html;
        }

        function decodeHtml(str) {
            if (!str) return str;
            return str
                .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'").replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>').replace(/&#x27;/g, "'")
                .replace(/&#x2F;/g, '/').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
        }

        const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
        const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1] ||
                        html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
        const ogPrice = html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i)?.[1];
        const ogDescription = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                              html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1];

        if (!ogImage) console.warn('No og:image found on', finalUrl);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({
                image: ogImage ? decodeHtml(ogImage) : null,
                title: ogTitle ? decodeHtml(ogTitle) : null,
                price: ogPrice ? decodeHtml(ogPrice) : null,
                description: ogDescription ? decodeHtml(ogDescription) : null,
                _resolved: finalUrl,
                _viaProxy: viaProxy
            })
        };
    } catch (error) {
        return { statusCode: 200, body: JSON.stringify({ error: 'Failed to fetch URL: ' + error.message, _resolved: finalUrl }) };
    }
};
