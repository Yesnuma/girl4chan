// Image proxy: lets the site draw item photos onto exportable canvases
// (eBay's image servers don't send CORS headers, which blocks canvas export).
// Restricted to known image hosts so it can't be abused as an open proxy.

const ALLOWED_HOSTS = [
  'ebayimg.com',
  'ebaystatic.com',
  'firebasestorage.googleapis.com',
  'media-photos.depop.com',
  'depop.com',
  'cloudfront.net',          // poshmark image CDN
  'media-assets.grailed.com',
  'vinted.net',
  'etsystatic.com'
];

exports.handler = async (event) => {
  try {
    const url = event.queryStringParameters && event.queryStringParameters.url;
    if (!url) {
      return { statusCode: 400, body: 'missing url' };
    }

    let parsed;
    try { parsed = new URL(url); } catch (e) {
      return { statusCode: 400, body: 'bad url' };
    }
    if (!ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
      return { statusCode: 403, body: 'host not allowed' };
    }

    const res = await fetch(url);
    if (!res.ok) {
      return { statusCode: res.status, body: 'fetch failed' };
    }
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400'
      },
      body: buf.toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    return { statusCode: 500, body: 'proxy error' };
  }
};
