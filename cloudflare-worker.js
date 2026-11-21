// Cloudflare Worker для Aftertone: атмосферная картинка дня (Workers AI, бесплатный лимит).
// 1) Текстовая модель превращает запись дня (на любом языке) в подробное описание сцены на английском.
// 2) FLUX.2 [klein] 9B рисует картинку с опорой на фото дня.
//    Запасные: Pollinations (бесплатно, без ключа) и FLUX.1 schnell. по описанию, опираясь на настоящее фото дня (если оно пришло).
//    Если эта модель недоступна или лимит исчерпан — запасной вариант FLUX.1 schnell.
// Нужна привязка Workers AI с именем переменной AI (Settings → Bindings → Workers AI).

// Для проверки оставьте '*'. Потом впишите адрес сайта без пути: 'https://thenextcreatoroffire.github.io'.
const ALLOWED_ORIGIN = '*';

const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const SYSTEM = `You are a cinematographer. Turn a personal diary entry (any language) into ONE English prompt for an image model
that recreates how that day FELT. Describe a single concrete, believable scene:
- the place and what surrounds it, time of day, season, weather;
- the light (direction, colour, softness), atmosphere (mist, steam, snowfall, dust in sunbeams), textures;
- 2-4 small sensory details mentioned in the entry (a mug of cocoa, wet leaves, city lights, confetti...);
- camera: framing, lens and depth of field, e.g. "35mm, shallow depth of field, eye level";
- the emotional mood in visual terms (cosy, lonely, electric, nostalgic...).
People only from behind, as silhouettes or far away; no faces, no text, no letters, no logos, no watermarks.
70-110 words, one paragraph. Output only the prompt.`;

async function writeScene(env, text) {
  for (const model of ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct']) {
    try {
      const r = await env.AI.run(model, {
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text.slice(0, 1500) }],
        max_tokens: 220,
      });
      if (r && r.response) return r.response.trim();
    } catch (e) { /* пробуем следующую модель */ }
  }
  return null;
}

// Бесплатный запасной вариант без ключа: Pollinations (анонимно — не чаще раза в ~15 секунд)
async function pollinations(prompt, pano) {
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt.slice(0, 1500)) +
    `?width=${pano ? 1536 : 1024}&height=768&model=flux&nologo=true&private=true&enhance=false&seed=${Math.floor(Math.random() * 1e9)}`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/')) throw new Error('HTTP ' + r.status);
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  } finally { clearTimeout(t); }
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: (head.match(/data:(.*?);/) || [])[1] || 'image/jpeg' });
}

// Озвучка: живой голос Google (как в Переводчике), без ключей. Текст до ~1500 символов режется на куски по 180.
function ttsChunks(text){
  const out = []; let cur = '';
  for (const s of String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…;:])\s+/)){
    const parts = s.length > 180 ? s.split(/(?<=,)\s+|\s+(?=—)/) : [s];
    for (let p of parts){ while (p.length > 180){ const k = p.lastIndexOf(' ', 180); out.push(p.slice(0, k > 40 ? k : 180)); p = p.slice(k > 40 ? k + 1 : 180); }
      if ((cur + ' ' + p).trim().length > 180){ if (cur) out.push(cur); cur = p; } else cur = (cur + ' ' + p).trim(); }
  }
  if (cur) out.push(cur); return out.slice(0, 12);
}
async function tts(url, request){
  const text = (url.searchParams.get('text') || '').slice(0, 1500), lang = url.searchParams.get('lang') || 'ru';
  if (!text.trim()) return new Response('no text', { status: 400, headers: cors });
  const cache = caches.default, key = new Request('https://tts.cache/' + lang + '/' + encodeURIComponent(text));
  const hit = await cache.match(key); if (hit) return new Response(hit.body, { headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' } });
  const bufs = [];
  for (const part of ttsChunks(text)){
    const r = await fetch('https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' + lang + '&q=' + encodeURIComponent(part), { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://translate.google.com/' } });
    if (!r.ok) return new Response('tts upstream ' + r.status, { status: 502, headers: cors });
    bufs.push(new Uint8Array(await r.arrayBuffer()));
  }
  const all = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0)); let o = 0; for (const b of bufs){ all.set(b, o); o += b.length; }
  const res = new Response(all, { headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' } });
  try { await cache.put(key, res.clone()); } catch {}
  return res;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname.endsWith('/tts')) return tts(url, request);
    if (request.method !== 'POST') return Response.json({ error: 'Only POST' }, { status: 405, headers: cors });
    try {
      const { prompt, text, style, photo, pano } = await request.json();
      if (typeof prompt !== 'string' || !prompt.trim()) return Response.json({ error: 'Bad prompt' }, { status: 400, headers: cors });

      const scene = (typeof text === 'string' && text.trim()) ? await writeScene(env, text) : null;
      let finalPrompt = (scene || prompt) + (style ? ', ' + style : '') + ', no text, no watermark';
      if (photo) finalPrompt += ', keep the place, light and composition of the reference photo, recreate its atmosphere';
      if (pano) finalPrompt = 'ultra-wide panoramic view of the whole surroundings, horizon in the middle, continuous scene from left to right, ' + finalPrompt;
      finalPrompt = finalPrompt.slice(0, 2000);

      const warnings = [];
      const klein = async (withPhoto) => {
        const form = new FormData();
        form.append('prompt', finalPrompt);
        form.append('width', pano ? '1920' : '1024');
        form.append('height', '768');
        if (withPhoto) form.append('input_image_0', dataUrlToBlob(photo), 'photo.jpg');
        const wrapped = new Response(form);
        const out = await env.AI.run('@cf/black-forest-labs/flux-2-klein-9b', { multipart: { body: wrapped.body, contentType: wrapped.headers.get('content-type') } });
        if (!out || !out.image) throw new Error('пустой ответ модели');
        return out.image;
      };
      const hasPhoto = typeof photo === 'string' && photo.startsWith('data:image');
      // 1) FLUX.2 [klein] с фото дня, 2) без фото, 3) Pollinations (бесплатно, без ключа), 4) FLUX.1 schnell
      const tries = [
        ...(hasPhoto ? [['flux-2-klein + фото', () => klein(true)]] : []),
        ['flux-2-klein', () => klein(false)],
        ['pollinations-flux', () => pollinations(finalPrompt, pano)],
        ['flux-1-schnell', async () => { const o = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt: finalPrompt, steps: 8 }); if (!o || !o.image) throw new Error('пустой ответ модели'); return o.image; }],
      ];
      for (const [name, run] of tries) {
        try {
          const b64 = await run();
          const mime = b64.startsWith('/9j') ? 'image/jpeg' : 'image/png';
          return Response.json({ image: `data:${mime};base64,` + b64, prompt: finalPrompt, model: name, warnings }, { headers: cors });
        } catch (e) { warnings.push(name + ': ' + (e && e.message ? e.message : String(e))); }
      }
      return Response.json({ error: 'все модели не ответили — ' + warnings.join(' | ') }, { status: 502, headers: cors });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500, headers: cors });
    }
  },
};
