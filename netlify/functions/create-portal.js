const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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

// Opens Stripe's hosted billing portal so people can cancel/manage
// girlchan premium or curator subscriptions themselves.
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    try {
        const { userId } = JSON.parse(event.body);
        if (!userId) return { statusCode: 400, body: JSON.stringify({ error: 'no user' }) };

        // customer id lives on the user doc (premium) or on any curator sub they bought
        let customerId = null;
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists && userDoc.data().stripeCustomerId) {
            customerId = userDoc.data().stripeCustomerId;
        } else {
            const subs = await db.collection('curatorSubs')
                .where('buyerId', '==', userId).get();
            subs.forEach(d => {
                if (!customerId && d.data().stripeCustomerId) customerId = d.data().stripeCustomerId;
            });
        }

        if (!customerId) {
            return { statusCode: 200, body: JSON.stringify({ error: 'no_subscriptions' }) };
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: 'https://girlchan.shopfinds.app/'
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ url: session.url })
        };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
