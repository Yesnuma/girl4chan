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
    try {
        const body = JSON.parse(event.body);
        imageUrl = body.imageUrl;
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    if (!imageUrl) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No imageUrl provided' }) };
    }

    try {
        // fetch image and convert to base64
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
        
        const token = await getEbayToken();
        
        const ebayRes = await fetch(
            'https://api.ebay.com/buy/browse/v1/item_summary/search_by_image?limit=12',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
                    'X-EBAY-C-ENDUSERCTX': 'affiliateCampaignId=5339134951,affiliateReferenceId=girlchan'
                },
                body: JSON.stringify({ image: base64Image })
            }
        );
        
        const data = await ebayRes.json();
        
        return {
            statusCode: 200,
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify(data)
        };
    } catch (err) {
        console.error('searchByImage error:', err);
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: err.message }) 
        };
    }
};
