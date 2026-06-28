const fetch = require('node-fetch');

// Desktop UA: Branch serves its parseable "deepview" interstitial (with the
// depop.app.link/nullproducts/<slug> anchor) to desktop requests, not mobile.
// Confirmed live that Depop product pages return og:image to a plain server
// fetch (status 200), so this same UA works for the final scrape too — the og
// tags live in the server-rendered <head>.
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

    // Pull just the URL out if the user pasted surrounding text
    const urlMatch = url.match(/https?:\/\/[^\s]+/);
    if (urlMatch) url = urlMatch[0];

    let finalUrl = url;
    let prefetchedHtml = null; // page captured during eBay redirect resolution, reused below
    const isShortEbayUrl = url.includes('ebay.us') || url.includes('ebay.to') || url.includes('ebay.io') || url.includes('rover.ebay.com');
    const isBranchLink = url.includes('app.link');

    // Resolve short eBay redirects only. The redirect-following GET already downloads
    // the full item page, so we keep its HTML instead of throwing it away — that lets
    // the scrape fallback below reuse it instead of making a second (timeout-risking) request.
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

    // Branch deep links (Depop share links) -> find the real product URL.
    if (isBranchLink) {
        try {
            const res = await fetch(url, {
                method: 'GET', redirect: 'follow',
                headers: { 'User-Agent': DESKTOP_UA },
                signal: AbortSignal.timeout(5000)
            });
            const html = await res.text();
            console.log('INTERSTITIAL SNIPPET:', html.slice(0, 1500));
console.log('HAS nullproducts:', html.includes('nullproducts'), '| HAS depop.com/products:', html.includes('depop.com/products'));
            const unescaped = html.replace(/\\\//g, '/'); // Branch JSON escapes slashes

            let destination = null;

            // PRIMARY: the product slug sits in a depop.app.link/(null)products/<slug>
            // anchor in the interstitial. Confirmed reliable — build canonical URL from it.
            const slugMatch = unescaped.match(/depop\.app\.link\/(?:null)?products?\/([^?"\s'&<]+)/i);
            if (slugMatch && slugMatch[1]) {
                destination = `https://www.depop.com/products/${slugMatch[1]}/`;
            }

            // FALLBACK: an explicit product URL printed anywhere in the page
            if (!destination) {
                const direct = unescaped.match(/https?:\/\/(?:www\.)?depop\.com\/products\/[^?"\s'&<]+/i)?.[0];
                if (direct) destination = direct;
            }

            // LAST RESORT: al:web:url — but ONLY if it points at a real product page.
            // (Do NOT use $desktop_url / og:url here: for Depop they resolve to the
            // homepage, which scrapes the generic Depop icon.)
            if (!destination) {
                const meta = html.match(/<meta[^>]+property=["']al:web:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
                if (meta && meta.includes('/products/')) destination = meta;
            }

            if (destination && !destination.includes('app.link')) {
                finalUrl = destination;
                console.log('Branch link resolved to:', finalUrl);
            } else {
                console.warn('Branch link did NOT resolve to a product. HTML length:', html.length);
            }
        } catch (e) {
            console.error('Branch resolution failed:', e.message);
        }
    }

    // eBay API path
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

    // Scrape og tags (works for Depop product pages, Grailed, Poshmark, etc.)
    try {
        let html;
        if (prefetchedHtml) {
            // We already downloaded this page while resolving the short link — reuse it.
            html = prefetchedHtml;
            console.log('Scrape: reusing prefetched HTML for', finalUrl);
        } else {
            const response = await fetch(finalUrl, {
                headers: {
                    'User-Agent': DESKTOP_UA,
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                redirect: 'follow',
                signal: AbortSignal.timeout(5000)
            });

            console.log('Scrape fetch:', finalUrl, '->', response.status);

            if (!response.ok) {
                return { statusCode: 200, body: JSON.stringify({ error: `Could not fetch page (${response.status})`, _resolved: finalUrl }) };
            }
            html = await response.text();
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
                _resolved: finalUrl
            })
        };
    } catch (error) {
        return { statusCode: 200, body: JSON.stringify({ error: 'Failed to fetch URL: ' + error.message, _resolved: finalUrl }) };
    }
};
