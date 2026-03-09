const fetch = require('node-fetch');

let cachedToken = null;
let tokenExpiry = 0;

async function getEbayToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
    
    const credentials = Buffer.from(
        `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
    ).toString('base64');
    
    const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${credentials}`
        },
        body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
    });
    
    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
    return cachedToken;
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { query } = JSON.parse(event.body);
        const token = await getEbayToken();

        const searchUrl = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=12&category_ids=220&filter=deliveryCountry:US`;

        const res = await fetch(searchUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await res.json();
        const items = (data.itemSummaries || []).map(item => ({
            id: item.itemId,
            title: item.title,
            image: item.image?.imageUrl || '',
            price: item.price?.value || '0'
        })).filter(item => item.image);

        return {
            statusCode: 200,
            body: JSON.stringify({ items })
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
