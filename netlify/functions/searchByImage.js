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

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let imageUrl;
    let query;
    let limit = 11;
    let offset = 0;

    try {
        const body = JSON.parse(event.body);
        imageUrl = body.imageUrl;
        query = body.query;
        if (body.limit) limit = body.limit;
        if (body.offset) offset = body.offset;
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    if (!imageUrl && !query) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No imageUrl or query provided' }) };
    }

    const categoryFilter = encodeURIComponent('categoryIds:!{171146|2984|182025|182034}');
    const ebayHeaders = {
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'X-EBAY-C-ENDUSERCTX': 'affiliateCampaignId=5339134951,affiliateReferenceId=girlchan'
    };

    try {
        const token = await getEbayToken();
        ebayHeaders['Authorization'] = `Bearer ${token}`;

        let ebayRes;

        if (query) {
            // KEYWORD SEARCH MODE
            const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' +
                encodeURIComponent(query) +
                '&limit=' + limit +
                '&offset=' + offset +
                '&filter=' + categoryFilter;

            ebayRes = await fetch(url, {
                method: 'GET',
                headers: ebayHeaders
            });
        } else {
            // IMAGE SEARCH MODE (unchanged)
            const imageResponse = await fetch(imageUrl, {
                signal: AbortSignal.timeout(8000)
            });
            if (!imageResponse.ok) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Could not fetch image' })
                };
            }
            const imageBuffer = await imageResponse.arrayBuffer();
            const base64Image = Buffer.from(imageBuffer).toString('base64');

            const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search_by_image?limit=' +
                limit + '&offset=' + offset
