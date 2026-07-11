/**
 * blue-lagune-proxy
 * Routen:
 *   POST /transcribe  -> Whisper (Audio -> Text)
 *   POST /tts         -> MeloTTS (Text -> Audio, de/en/es/fr/it)
 *   POST /            -> Anthropic-Proxy (Claude)
 *
 * KI-Zugriff: nutzt env.AI (Binding aus wrangler.jsonc); wenn nicht
 * vorhanden, automatisch Fallback auf REST-API mit env.CF_AI_TOKEN.
 */

const ACCOUNT_ID = '48e67390b239f6052058573c6858f12a';
const AI_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run`;

async function runAI(env, model, input, expectAudio) {
  // 1) Bevorzugt: Binding
  if (env.AI && env.AI.run) {
    return { kind: 'binding', result: await env.AI.run(model, input) };
  }
  // 2) Fallback: REST mit Token
  const res = await fetch(`${AI_BASE}/${model}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_AI_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (expectAudio) {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('audio') || ct.includes('octet-stream')) {
      return { kind: 'rest-audio', body: res.body };
    }
  }
  return { kind: 'rest-json', data: await res.json() };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // ---------- Whisper: Audio -> Text ----------
    if (url.pathname === '/transcribe') {
      try {
        const formData  = await request.formData();
        const audioFile = formData.get('audio');
        if (!audioFile) return json({ error: 'Kein Audio' }, 400, cors);
        const buffer = await audioFile.arrayBuffer();
        const audioArray = [...new Uint8Array(buffer)];

        const out = await runAI(env, '@cf/openai/whisper', { audio: audioArray }, false);
        const text = out.kind === 'binding'
          ? (out.result.text || '')
          : ((out.data.result && out.data.result.text) || '');
        return json({ text }, 200, cors);
      } catch (err) {
        return json({ error: err.message }, 500, cors);
      }
    }

    // ---------- TTS: Text -> Sprache (MeloTTS) ----------
    if (url.pathname === '/tts') {
      try {
        const { text, lang } = await request.json();
        if (!text) return json({ error: 'Kein Text' }, 400, cors);
        const l = ['de','en','es','fr','it'].includes(lang) ? lang : 'en';

        const out = await runAI(env, '@cf/myshell-ai/melotts', { prompt: text, lang: l }, true);

        if (out.kind === 'binding') {
          const r = out.result;
          if (r instanceof ReadableStream) {
            return new Response(r, { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });
          }
          if (r && r.audio) {
            const bin = Uint8Array.from(atob(r.audio), c => c.charCodeAt(0));
            return new Response(bin, { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });
          }
          return json({ error: 'tts_unerwartet', r }, 502, cors);
        }
        if (out.kind === 'rest-audio') {
          return new Response(out.body, { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });
        }
        // rest-json: Audio kann als base64 in result.audio stecken
        const d = out.data;
        if (d && d.result && d.result.audio) {
          const bin = Uint8Array.from(atob(d.result.audio), c => c.charCodeAt(0));
          return new Response(bin, { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });
        }
        return json({ error: 'tts_unerwartet', d }, 502, cors);
      } catch (err) {
        return json({ error: err.message }, 500, cors);
      }
    }

    // ---------- Anthropic Proxy ----------
    if (request.method === 'POST') {
      try {
        const body   = await request.json();
        const apiKey = request.headers.get('x-api-key') || env.ANTHROPIC_KEY || '';
        const res    = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        });
        return json(await res.json(), res.status, cors);
      } catch (err) {
        return json({ error: err.message }, 500, cors);
      }
    }

    return new Response('OK', { headers: cors });
  }
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
