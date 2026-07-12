const fetch = require('node-fetch');
const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        })
    });
}
const db = admin.firestore();

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { userId, email, curatorId } = JSON.parse(event.body);

        const params = new URLSearchParams();

        if (curatorId) {
            // ── CURATOR SUBSCRIPTION / UNLOCK ──
            // price + model come from the curator's own settings (server-side, tamper-proof)
            const curatorDoc = await db.collection('users').doc(curatorId).get();
            if (!curatorDoc.exists) {
                return { statusCode: 400, body: JSON.stringify({ error: 'curator not found' }) };
            }
            const c = curatorDoc.data();
            if (c.premium !== true || c.subEnabled !== true) {
                return { statusCode: 400, body: JSON.stringify({ error: 'curator subscriptions not enabled' }) };
            }
            const priceDollars = [2, 3, 5, 8, 10].includes(c.subPrice) ? c.subPrice : 3;
            const cents = priceDollars * 100;
            const model = c.subModel === 'once' ? 'once' : 'monthly';
            const curatorName = (c.username || 'curator') + '.finds';

            params.append('line_items[0][price_data][currency]', 'usd');
            params.append('line_items[0][price_data][product_data][name]',
                model === 'once' ? 'unlock ' + curatorName + ' on girlchan' : 'subscribe to ' + curatorName + ' on girlchan');
            params.append('line_items[0][price_data][unit_amount]', String(cents));
            params.append('line_items[0][quantity]', '1');

            if (model === 'monthly') {
                params.append('mode', 'subscription');
                params.append('line_items[0][price_data][recurring][interval]', 'month');
                // carry curator info on the subscription itself so cancellations can be traced
                params.append('subscription_data[metadata][userId]', userId);
                params.append('subscription_data[metadata][curatorId]', curatorId);
            } else {
                params.append('mode', 'payment');
            }

            params.append('metadata[userId]', userId);
            params.append('metadata[curatorId]', curatorId);
            params.append('metadata[model]', model);
            params.append('success_url', 'https://girlchan.shopfinds.app/#sub-success');
            params.append('cancel_url', 'https://girlchan.shopfinds.app/#sub-cancel');
        } else {
            // ── GIRLCHAN PREMIUM (unchanged) ──
            params.append('mode', 'subscription');
            params.append('line_items[0][price]', process.env.STRIPE_PRICE_ID);
            params.append('line_items[0][quantity]', '1');
            params.append('success_url', 'https://girlchan.shopfinds.app/#premium-success');
            params.append('cancel_url', 'https://girlchan.shopfinds.app/#premium-cancel');
            params.append('metadata[userId]', userId);
            params.append('allow_promotion_codes', 'true');
        }

        params.append('customer_email', email);

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
