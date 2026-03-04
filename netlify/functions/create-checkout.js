const fetch = require('node-fetch');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { userId, email } = JSON.parse(event.body);

        const params = new URLSearchParams();
        params.append('mode', 'subscription');
        params.append('line_items[0][price]', process.env.STRIPE_PRICE_ID);
        params.append('line_items[0][quantity]', '1');
        params.append('success_url', 'https://girlchan.shopfinds.app/#premium-success');
        params.append('cancel_url', 'https://girlchan.shopfinds.app/#premium-cancel');
        params.append('customer_email', email);
        params.append('metadata[userId]', userId);
        params.append('allow_promotion_codes', 'true');

        const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString()
        });

        const session = await response.json();

        return {
            statusCode: 200,
            body: JSON.stringify({ url: session.url })
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
