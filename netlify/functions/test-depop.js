exports.handler = async () => {
  try {
    const p = await fetch('https://www.depop.com/products/ladyjuicyxqxo-juicy-couture-blue-and-black-8828/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    const body = await p.text();
    return {
      statusCode: 200,
      body: JSON.stringify({
        depopStatus: p.status,
        hasOgImage: body.includes('og:image'),
        snippet: body.slice(0, 300)
      })
    };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ error: e.message }) };
  }
};
