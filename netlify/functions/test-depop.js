exports.handler = async () => {
  const slug = 'ladyjuicyxqxo-juicy-couture-blue-and-black-8828'; // a known live slug
  const tries = [
    `https://webapi.depop.com/api/v2/products/${slug}/`,
    `https://webapi.depop.com/api/v1/products/${slug}/`,
  ];
  const out = [];
  for (const u of tries) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      const text = await r.text();
      out.push({ url: u, status: r.status, snippet: text.slice(0, 400) });
    } catch (e) {
      out.push({ url: u, error: e.message });
    }
  }
  return { statusCode: 200, body: JSON.stringify(out, null, 2) };
};
