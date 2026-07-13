const fetch = require('node-fetch');

// Free PNG/pattern search for wallpapers, powered by Pixabay.
// Requires PIXABAY_API_KEY in Netlify env (free at pixabay.com/api/docs).
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    if (!process.env.PIXABAY_API_KEY) {
        return { statusCode: 200, body: JSON.stringify({ error: 'no_key', hits: [] }) };
    }

    let query, page = 1, style = 'photo';
    try {
        const body = JSON.parse(event.body);
        query = body.query;
        if (body.page) page = body.page;
        if (body.style) style = body.style;
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'bad request' }) };
    }
    if (!query || !query.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'no query' }) };
    }

    try {
        // 'shape' = clipart/silhouettes with transparent backgrounds — tiles beautifully
        const typeParams = style === 'shape'
            ? '&image_type=vector&colors=transparent'
            : '&image_type=all';
        const url = 'https://pixabay.com/api/?key=' + process.env.PIXABAY_API_KEY +
            '&q=' + encodeURIComponent(query.trim()) + typeParams +
            '&safesearch=true&order=popular&per_page=24&page=' + page;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        const hits = (data.hits || []).map(h => ({
            preview: h.previewURL,
            full: h.webformatURL || h.largeImageURL,
            tags: h.tags || ''
        }));
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ hits: hits, total: data.totalHits || 0 })
        };
    } catch (err) {
        return { statusCode: 200, body: JSON.stringify({ error: err.message, hits: [] }) };
    }
};
