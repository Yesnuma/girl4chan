const fetch = require('node-fetch');

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
    // Extract item ID from various eBay URL formats
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

    // Resolve short URLs first
    let finalUrl = url;
    try {
        const headRes = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
            signal: AbortSignal.timeout(5000)
        });
        finalUrl = headRes.url;
    } catch (e) {
        finalUrl = url;
    }

    // Use eBay API if it's an eBay URL
    const isEbay = finalUrl.includes('ebay.com') || finalUrl.includes('ebay.us') || url.includes('ebay.com') || url.includes('ebay.us');
    
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
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(8000)
        });

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
                              html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1];

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
