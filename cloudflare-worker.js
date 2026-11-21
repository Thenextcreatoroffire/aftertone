// Cloudflare Worker для Aftertone: атмосферная картинка дня (Workers AI, бесплатный лимит).
// 1) Текстовая модель превращает запись дня (на любом языке) в подробное описание сцены на английском.
// 2) FLUX.2 [klein] 9B рисует картинку (или широкую панораму для режима 360°, если пришло pano: true) по описанию, опираясь на настоящее фото дня (если оно пришло).
//    Если эта модель недоступна или лимит исчерпан — запасной вариант FLUX.1 schnell.
// Нужна привязка Workers AI с именем переменной AI (Settings → Bindings → Workers AI).

// Для проверки оставьте '*'. Потом впишите адрес сайта без пути: 'https://thenextcreatoroffire.github.io'.
const ALLOWED_ORIGIN = '*';

const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM = `You turn a personal diary entry (any language) into ONE English prompt for an image model.
Describe a single concrete, realistic scene that recreates the atmosphere of that day: the place, time of day, season,
weather, light, key objects and small sensory details from the entry, colors and textures, the emotional mood.
People only from behind or far away, no faces, no text, no logos. 60-90 words. Output only the prompt, nothing else.`;

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

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: (head.match(/data:(.*?);/) || [])[1] || 'image/jpeg' });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return Response.json({ error: 'Only POST' }, { status: 405, headers: cors });
    try {
      const { prompt, text, style, photo, pano } = await request.json();
      if (typeof prompt !== 'string' || !prompt.trim()) return Response.json({ error: 'Bad prompt' }, { status: 400, headers: cors });

      const scene = (typeof text === 'string' && text.trim()) ? await writeScene(env, text) : null;
      let finalPrompt = (scene || prompt) + (style ? ', ' + style : '');
      if (photo) finalPrompt += ', keep the place, light and composition of the reference photo, recreate its atmosphere';
      if (pano) finalPrompt = 'ultra-wide panoramic view of the whole surroundings, horizon in the middle, continuous scene from left to right, ' + finalPrompt;
      finalPrompt = finalPrompt.slice(0, 2000);

      // Основная модель: FLUX.2 [klein] 9B с опорой на фото дня
      try {
        const form = new FormData();
        form.append('prompt', finalPrompt);
        form.append('width', pano ? '1920' : '1024');
        form.append('height', pano ? '768' : '768');
        if (typeof photo === 'string' && photo.startsWith('data:image')) form.append('input_image_0', dataUrlToBlob(photo), 'photo.jpg');
        const wrapped = new Response(form);
        const out = await env.AI.run('@cf/black-forest-labs/flux-2-klein-9b', {
          multipart: { body: wrapped.body, contentType: wrapped.headers.get('content-type') },
        });
        if (out && out.image) return Response.json({ image: 'data:image/png;base64,' + out.image, prompt: finalPrompt, model: 'flux-2-klein-9b' }, { headers: cors });
      } catch (e) { /* переходим на запасную модель */ }

      // Запасная модель: FLUX.1 schnell
      const out = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt: finalPrompt, steps: 8 });
      return Response.json({ image: 'data:image/jpeg;base64,' + out.image, prompt: finalPrompt, model: 'flux-1-schnell' }, { headers: cors });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500, headers: cors });
    }
  },
};
