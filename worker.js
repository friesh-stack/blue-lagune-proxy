/**
 * blue-lagune-proxy
 * Routen:
 *   POST /transcribe  -> Whisper (Audio -> Text)
 *   POST /tts         -> MeloTTS (Text -> Audio, de/en/es/fr/it)
 *   POST /live        -> Sprachassistent (OpenAI GPT-Live) für dünenvilla.de & Inselzeit
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
    // ---------- Sprachassistent: OpenAI GPT-Live ----------
    if (url.pathname === '/live') return handleLive(request, env);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/license-rs')) return new Response(null, { headers: cors });

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

/* ===================== Sprachassistent (GPT-Live) ===================== */
const LIVE_INSTRUCTIONS = (greeting, brand) => `
Du bist die freundliche Sprach-Gastgeberin von "${brand}", einer kleinen privaten Vermietung von Ferienunterkünften auf der Halbinsel Mönchgut (Rügen).
Beginne das Gespräch sofort mit: "${greeting}"
Sprich Deutsch. Wenn der Gast eine andere Sprache spricht, antworte in seiner Sprache.
Sprich warm, ruhig und natürlich, in kurzen Antworten (meist ein bis drei Sätze). Lass dich unterbrechen und hör dann zu.
Für alles Konkrete – Preise, Preisberechnungen, freie Termine, Ausstattung, Lage, Entfernungen, Hunde, Kurabgabe, Kurkarte, Kurverwaltung, Veranstaltungen – delegiere an das Backend und gib dessen Antwort gesprochen wieder. Erfinde keine Zahlen, Daten oder Telefonnummern.
Frag bei Preisfragen nach Anreise, Abreise, Personenzahl, Kindern unter 6 und Hunden, wenn das fehlt.
Du kannst nicht verbindlich buchen. Wenn der Gast buchen möchte, fasse Wohnung, Zeitraum und Preis kurz zusammen und bitte ihn, das Anfrageformular auf der Seite zu nutzen (Knopf "Anfrageformular").
Lies Telefonnummern langsam in Zifferngruppen vor. Bleib beim Thema Urlaub auf Mönchgut. Du bist ein KI-Assistent; sag das ehrlich, wenn jemand fragt.`;

const BACKEND_INSTRUCTIONS = (kb, brand) => `
Du beantwortest Fragen für den Sprachassistenten von "${brand}". Antworte knapp und gesprochen-tauglich auf Deutsch (keine Tabellen, keine Markdown-Zeichen, Beträge als "320 Euro").
Nutze ausschließlich die folgende Wissensbasis. Wenn etwas dort nicht steht, sag das ehrlich und verweise auf das Anfrageformular bzw. bei Fragen zur Kurabgabe auf die Kurverwaltung Mönchgut (Telefon 038308 66010).
Rechne Preise sorgfältig Nacht für Nacht nach Saison und nenne die Bestandteile kurz. Prüfe Belegungen: Ein Zeitraum ist nur frei, wenn keine Nacht in einem belegten Zeitraum liegt.

=== WISSENSBASIS ===
${kb}`;

async function handleLive(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const originOk = (origin === "null" && env.ALLOW_FILE === "1") || allowed.length === 0 || allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": originOk ? (origin || "*") : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return out({ error: "method" }, 405);
    if (!originOk) return out({ error: "origin not allowed" }, 403);

    let body;
    try { body = await req.json(); } catch { return out({ error: "bad json" }, 400); }
    const { sdp, kb, greeting, brand } = body || {};
    if (typeof sdp !== "string" || !sdp.startsWith("v=0") || sdp.length > 20000) return out({ error: "bad sdp" }, 400);
    if (typeof kb !== "string" || kb.length > 30000) return out({ error: "bad kb" }, 400);
    const brandName = (typeof brand === "string" && brand.trim() ? brand : "Ferienwohnungen Mönchgut").slice(0, 80);
    const greet = (typeof greeting === "string" ? greeting : "Herzlich willkommen! Wie kann ich Ihnen helfen?").slice(0, 200);

    const r = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          model: "gpt-live-1",
          instructions: LIVE_INSTRUCTIONS(greet, brandName),
          audio: { output: { voice: env.VOICE || "marin" } },
          delegation: {
            type: "responses",
            responses: {
              model: env.BACKEND_MODEL || "gpt-5.6-terra",
              instructions: BACKEND_INSTRUCTIONS(kb, brandName),
              text: { verbosity: "low" },
            },
          },
        },
        transport: { type: "webrtc", sdp },
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error("OpenAI live error", r.status, detail.slice(0, 500));
      return out({ error: "live session failed", status: r.status }, 502);
    }
    const data = await r.json();
    return out({ sdp: data?.transport?.sdp, id: data?.session?.id });
  }
