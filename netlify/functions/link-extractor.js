const fetch = require('node-fetch');

// Desktop browser UA. Confirmed (by fetching a real depop.app.link) that Branch
// serves its "deepview" interstitial to desktop requests — and that page contains
// a plain depop.app.link/nullproducts/<slug> anchor we can parse. A MOBILE UA gets
// a different interstitial where the slug is buried in escaped JS the regex misses.
const UNFURL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
        const body = JSON.parse(event.body);
        url = body.url;
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    if (!url) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No URL provided' }) };
    }

    // If the user pasted a message containing other text alongside a URL, extract just the URL
    const urlMatch = url.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
        url = urlMatch[0];
    }

    let finalUrl = url;
    const isShortEbayUrl = url.includes('ebay.us') || url.includes('ebay.to') || url.includes('ebay.io') || url.includes('rover.ebay.com');
    const isBranchLink = url.includes('app.link');

    // Resolve short eBay URLs ONLY. (Branch links serve 200 HTML, not a redirect,
    // so a HEAD here is wasted budget — the Branch block below does its own GET.
    // Plain full URLs don't need pre-resolution; the final scraper follows redirects.)
    if (isShortEbayUrl) {
        try {
            const res = await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                headers: { 'User-Agent': UNFURL_UA },
                signal: AbortSignal.timeout(6000)
            });
            finalUrl = res.url;
            console.log('Resolved short eBay URL:', finalUrl);
        } catch (e) {
            console.error('URL resolution failed:', e.message);
            finalUrl = url;
        }
    }

    // Branch deep links (Depop share links, etc.) — parse HTML for real destination
    if (isBranchLink) {
        try {
            const res = await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                headers: { 'User-Agent': UNFURL_UA },
                signal: AbortSignal.timeout(6000)
            });
            const html = await res.text();
            const htmlUnescaped = html.replace(/\\\//g, '/'); // Branch JSON escapes slashes

            // Standard meta tags first
            const alWebUrl = html.match(/<meta[^>]+property=["']al:web:url["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                             html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']al:web:url["']/i)?.[1];
            const ogUrl = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i)?.[1];

            let destination = alWebUrl || (ogUrl && !ogUrl.includes('app.link') ? ogUrl : null);

            // Branch embeds the real URL in its branch_data JSON blob
            if (!destination || destination.includes('app.link')) {
                const canonical = htmlUnescaped.match(/["']\$canonical_url["']\s*:\s*["']([^"']+)["']/i)?.[1] ||
                                  htmlUnescaped.match(/["']\$desktop_url["']\s*:\s*["']([^"']+)["']/i)?.[1];
                if (canonical && !canonical.includes('app.link')) destination = canonical;
            }

            // Any direct Depop product URL anywhere in the page
            if (!destination || destination.includes('app.link')) {
                const direct = htmlUnescaped.match(/https?:\/\/(?:www\.)?depop\.com\/products\/[^?"\s'&]+/i)?.[0];
                if (direct) destination = direct;
            }

            // Last resort: slug appended to the app.link domain
            if ((!destination || destination.includes('app.link')) && (url.includes('depop.app.link') || finalUrl.includes('depop.app.link'))) {
                const depopProductMatch = html.match(/depop\.app\.link\/(?:null)?products?\/([^?"\s'&]+)/i);
                if (depopProductMatch && depopProductMatch[1]) {
                    destination = `https://www.depop.com/products/${depopProductMatch[1]}/`;
                }
            }

            if (destination && !destination.includes('app.link')) {
                finalUrl = destination;
                console.log('Branch link resolved to:', finalUrl);
            } else {
                console.warn('Branch link did NOT resolve to a destination. Falling back to:', finalUrl);
            }
        } catch (e) {
            console.error('Branch resolution failed:', e.message);
        }
    }

    // Use eBay API if it's an eBay URL
    const isEbay = finalUrl.includes('ebay.com') || finalUrl.includes('ebay.us') || finalUrl.includes('ebay.io') || url.includes('ebay.com') || url.includes('ebay.us') || url.includes('ebay.io');

    if (isEbay) {
        try {
            const ebayData = await fetchEbayItem(finalUrl);
            if (ebayData) {
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                    body: JSON.stringify(ebayData)
                };
            }
        } catch (e) {
            console.error('eBay API error:', e);
        }
    }

    // Fallback: scrape HTML for non-eBay or if API failed
    try {
        const response = await fetch(finalUrl, {
            headers: {
                'User-Agent': UNFURL_UA,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(6000)
        });

        console.log('Scrape fetch:', finalUrl, '->', response.status);

        if (!response.ok) {
            return { statusCode: 200, body: JSON.stringify({ error: `Could not fetch page (${response.status})` }) };
        }

        const html = await response.text();

        function decodeHtml(str) {
            if (!str) return str;
            return str
                .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'").replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>').replace(/&#x27;/g, "'")
                .replace(/&#x2F;/g, '/').replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)));
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
                description: ogDescription ? decodeHtml(ogDescription) : null
            })
        };
    } catch (error) {
        return { statusCode: 200, body: JSON.stringify({ error: 'Failed to fetch URL: ' + error.message }) };
    }
};
