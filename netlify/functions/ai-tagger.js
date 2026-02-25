const fetch = require('node-fetch');
const MASTER_TAG_LIST = [
    'baby-tee', 'tank-top', 'crop-top', 'halter-top', 'tube-top', 'butterfly-top',
    'hoodie', 'cardigan', 'sweater', 'blazer', 'jacket', 'corset', 'bodysuit',
    'long-sleeve-top', 'graphic-tee', 'turtleneck', 'polo', 'zip-up',
    'low-rise-jeans', 'cargo-pants', 'mini-skirt', 'maxi-skirt', 'midi-skirt',
    'pleated-skirt', 'denim-skirt', 'flare-jeans', 'baggy-jeans', 'shorts',
    'yoga-pants', 'leggings', 'sweatpants', 'track-pants', 'bike-shorts',
    'wide-leg-pants', 'straight-leg-jeans', 'skinny-jeans', 'mom-jeans',
    'mini-dress', 'midi-dress', 'maxi-dress', 'slip-dress', 'sundress',
    'party-dress', 'bodycon-dress', 'babydoll-dress', 'romper', 'jumpsuit',
    'platform-shoes', 'heels', 'sneakers', 'boots', 'mary-janes', 'ballet-flats',
    'bag', 'belt', 'sunglasses', 'jewelry', 'hair-clip',
    'y2k', 'grunge', 'coquette', 'cottagecore', 'mcbling', 'indie-sleaze',
    'cyber-y2k', 'streetwear', '90s', '00s', 'vintage', 'preppy', 'goth',
    'rhinestones', 'lace', 'distressed', 'graphic-print', 'butterfly',
    'velvet', 'mesh', 'sequins', 'denim', 'leather', 'satin', 'knit',
    'fur-trim', 'ruffles', 'cutout', 'tie-dye', 'plaid', 'floral',
    'pink', 'baby-blue', 'black', 'white', 'hot-pink', 'lavender',
    'lime-green', 'silver', 'gold', 'red', 'purple', 'yellow', 'brown',
    'grey', 'orange', 'green', 'blue',
    'party', 'casual', 'edgy', 'girly', 'preppy', 'vintage', 'sexy',
    'cute', 'sporty', 'elegant', 'grunge', 'romantic' 'cute', 'sporty', 'elegant', 'grunge', 'romantic',
    'boho', 'minimalist', 'maximalist', 'old-money', 'clean-girl', 'mob-wife', 'coastal',
    '70s', '80s', '2010s',
    'fringe', 'embroidered', 'beaded', 'sheer', 'cropped',
    'animal-print', 'stripes', 'polka-dot', 'camo', 'checkered',
    'numbers',
    'office-siren', 'off-shoulder', 'oversized', 'fitted', 'high-waisted',
    'low-rise', 'backless', 'strapless', 'asymmetric',
    'western', 'biker', 'ballet-core', 'quiet-luxury', 'dark-academia',
    'light-academia', 'fairy-grunge', 'coastal-grandmother',
    'matching-set', 'two-piece', 'layered',
    'logo', 'brand-name', 'designer', 'handmade',
    'chunky', 'dainty', 'statement-piece',
    'summer', 'winter', 'fall', 'spring',
    'going-out', 'date-night', 'festival', 'workwear' 'retro', 'retro-sportswear', 'ooak', 'rare', 'deadstock',
'sustainable', 'secondhand', 'thrifted',
'band-tee', 'graphic-sweatshirt', 'cable-knit', 'tailored',
'indie', 'indie-vanguard', 'contemporary-classic',
'monochrome', 'neutral', 'earth-tones', 'pastel',
'silk', 'cashmere', 'linen', 'wool', 'corduroy', 'suede',
'platform', 'chunky-sole', 'kitten-heel', 'mules', 'sandals', 'loafers',
'mini', 'maxi', 'midi', 'oversized-fit',
'90s-sportswear', 'track-jacket', 'windbreaker', 'varsity',
'pearl', 'chain', 'hoop-earrings', 'pendant',
'tote-bag', 'crossbody', 'clutch', 'shoulder-bag', 'backpack'
];

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { image } = JSON.parse(event.body);
        
        const prompt = `Analyze this fashion item image and return ONLY tags from this exact list: ${MASTER_TAG_LIST.join(', ')}.

Important instructions:
- Return between 5-15 tags that best describe the item
- Only use tags from the provided list (no variations or new tags)
- Focus on: item type, aesthetic/era, dominant colors, notable details, and overall vibe
- Return ONLY a JSON array of strings, nothing else

Respond with just the JSON array, no other text.`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o",
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: image } }
                    ]
                }],
                max_tokens: 300
            })
        });

        const data = await response.json();
        let content = data.choices[0].message.content.trim();
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const tags = JSON.parse(content);

        return {
            statusCode: 200,
            body: JSON.stringify({ tags })
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
