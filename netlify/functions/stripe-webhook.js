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

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const stripeEvent = JSON.parse(event.body);

        if (stripeEvent.type === 'checkout.session.completed') {
            const session = stripeEvent.data.object;
            const userId = session.metadata.userId;

            if (userId) {
                await db.collection('users').doc(userId).set({
                    premium: true,
                    premiumSince: new Date().toISOString(),
                    stripeCustomerId: session.customer
                }, { merge: true });
            }
        }

        if (stripeEvent.type === 'customer.subscription.deleted') {
            const subscription = stripeEvent.data.object;
            const customerId = subscription.customer;

            const usersSnapshot = await db.collection('users')
                .where('stripeCustomerId', '==', customerId)
                .get();

            usersSnapshot.forEach(async (doc) => {
                await doc.ref.update({ premium: false });
            });
        }

        return { statusCode: 200, body: JSON.stringify({ received: true }) };
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }
};
