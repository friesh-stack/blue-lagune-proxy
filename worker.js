/**
 * blue-lagune-proxy
 * Routen:
 *   POST /transcribe  -> Whisper (Audio -> Text)
 *   POST /tts         -> MeloTTS (Text -> Audio, de/en/es/fr/it)
 *   POST /live        -> Sprachassistent (OpenAI GPT-Live) für dünenvilla.de, Inselzeit & ostseebad-mönchgut.de
 *                        (mode:"vermieter" = Beratung für Vermieter auf der Portal-Startseite)
 *   POST /extract     -> liest Buchungsdaten aus dem Gesprächsverlauf (für das Anfrageformular)
 *   POST /anfrage     -> leitet eine Gästeanfrage weiter (Push via ntfy, optional Apps Script)
 *   POST /translate   -> übersetzt Seitentexte (DE -> EN/SV/PL/FR), 30 Tage zwischengespeichert
 *   GET  /news        -> „Aktuelles auf Mönchgut“: Meldungen in eigenen Worten + Tipp der Woche (12 h zwischengespeichert)
 *                        optional mit Mails der Kurverwaltung (Secrets KURMAIL_URL + KURMAIL_TOKEN, Apps Script)
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    // ---------- Sprachassistent: OpenAI GPT-Live ----------
    if (url.pathname === '/live') return handleLive(request, env);
    if (url.pathname === '/extract') return handleExtract(request, env);
    if (url.pathname === '/anfrage') return handleAnfrage(request, env);
    if (url.pathname === '/translate') return handleTranslate(request, env, ctx);
    if (url.pathname === '/news') return handleNews(request, env, ctx);

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
const LANGS = { de: "Deutsch", en: "Englisch", sv: "Schwedisch", pl: "Polnisch", fr: "Französisch" };
const GREETINGS = {
  en: b => `Hello and welcome to ${b}! How can I help you?`,
  sv: b => `Hej och välkommen till ${b}! Hur kan jag hjälpa dig?`,
  pl: b => `Dzień dobry, witamy w ${b}! W czym mogę pomóc?`,
  fr: b => `Bonjour et bienvenue chez ${b} ! Comment puis-je vous aider ?`,
};
const LIVE_INSTRUCTIONS = (greeting, brand, form, lang = "de", name = "", address = false) => `
Du bist ${name ? `${name}, der freundliche KI-Sprachassistent` : "die freundliche Sprach-Gastgeberin"} von "${brand}", einer kleinen privaten Vermietung von Ferienunterkünften auf der Halbinsel Mönchgut (Rügen).
Beginne das Gespräch sofort mit: "${greeting}"
SPRACHEN: Standardsprache ist Deutsch.${lang !== "de" ? ` Dieses Gespräch beginnt auf ${LANGS[lang]}, weil der Gast die Webseite auf ${LANGS[lang]} nutzt.` : ""} Du sprichst fließend Deutsch, Englisch, Schwedisch, Polnisch und Französisch. Antworte immer in der Sprache, in der der Gast zuletzt gesprochen hat, und wechsle sofort mit, wenn er die Sprache wechselt. Gib die Auskünfte aus dem Backend in dieser Sprache wieder. Eigennamen (Wohnungs-, Orts- und Straßennamen) bleiben unverändert. Spricht der Gast eine andere Sprache, antworte möglichst in dieser, sonst auf Englisch.
Sprich warm, ruhig und natürlich, in kurzen Antworten (meist ein bis drei Sätze). Lass dich unterbrechen und hör dann zu.
Für alles Konkrete – Preise, Preisberechnungen, freie Termine, Ausstattung, Lage, Entfernungen, Hunde, Kurabgabe, Kurkarte, Kurverwaltung, Veranstaltungen – delegiere an das Backend und gib dessen Antwort gesprochen wieder. Erfinde keine Zahlen, Daten oder Telefonnummern.
Frag bei Preisfragen nach Anreise, Abreise, Personenzahl, Kindern unter 6 und Hunden, wenn das fehlt.
${form ? `ANFRAGE AUFNEHMEN: Wenn der Gast buchen oder anfragen möchte, nimm die Anfrage im Gespräch auf. Frag Schritt für Schritt (immer nur ein, zwei Dinge auf einmal) nach allem, was noch fehlt:
1. Wohnung, Anreise- und Abreisedatum, Anzahl Personen (davon Kinder unter 6), Hunde.
2. Vor- und Nachname. Dann frag: "Wie dürfen wir Ihnen antworten – per E-Mail oder per WhatsApp?"
   – WhatsApp (oder Anruf): frag nach der Handynummer. Wiederhole sie langsam in Zweier- oder Dreiergruppen und lass sie dir bestätigen.
   – E-Mail: bitte den Gast, die Adresse zu buchstabieren. Lies sie danach Buchstabe für Buchstabe zurück, inklusive "at", "Punkt", "Bindestrich", "Unterstrich", und lass sie bestätigen. Bei ähnlich klingenden Buchstaben (B/P, D/T, M/N, F/S) frag nach ("B wie Berta?"). Eine falsche E-Mail-Adresse bedeutet, dass der Gast nie eine Antwort bekommt – sei hier besonders genau.
   – Frag zusätzlich freiwillig nach der jeweils anderen Angabe (Telefon für Rückfragen bzw. E-Mail), dränge aber nicht.
${address ? `3. Anschrift für die Kurkarte: Straße und Hausnummer, Postleitzahl und Ort, bei Gästen aus dem Ausland auch das Land. Erklär kurz, dass die Anschrift für die Kurkarte (Meldeschein) gebraucht wird. Wiederhole sie zur Kontrolle.
` : ""}Alles, was der Gast sagt, wird automatisch in das Anfrageformular auf dem Bildschirm eingetragen. Wenn alles da ist: Nenne den unverbindlichen Gesamtpreis (zuzüglich Kurabgabe) und fasse die Angaben kurz zusammen. Sag dann sinngemäß in der Sprache des Gastes: "Ich habe alles ins Anfrageformular eingetragen, Sie sehen es auf dem Bildschirm. Soll ich die Anfrage jetzt abschicken, oder möchten Sie die Daten noch einmal prüfen?"
Behaupte nie, die Anfrage sei abgeschickt, bevor du eine Bestätigung bekommst, dass sie gesendet wurde. Möchte der Gast prüfen, sag ihm, dass er im Formular alles ändern und dort selbst auf "Anfrage senden" tippen kann.
Sag vor dem Abschicken kurz dazu, dass die Angaben nur zur Bearbeitung der Anfrage gespeichert werden; die Zustimmung zum Abschicken gilt als Einverständnis.
Es ist eine unverbindliche Anfrage, keine feste Buchung: Der Gastgeber meldet sich mit der Bestätigung.` : `Du kannst nicht verbindlich buchen. Wenn der Gast buchen möchte, fasse Wohnung, Zeitraum und Preis kurz zusammen und bitte ihn, das Anfrageformular auf der Seite zu nutzen (Knopf "Anfrageformular").`}
Lies Telefonnummern langsam in Zifferngruppen vor. Bleib beim Thema Urlaub auf Mönchgut. Du bist ein KI-Assistent; sag das ehrlich, wenn jemand fragt.`;

const VERMIETER_INSTRUCTIONS = (greeting, brand, lang = "de") => `
Du bist der freundliche digitale Berater von "${brand}" (ostseebad-mönchgut.de). Du sprichst mit Vermieterinnen und Vermietern von Ferienwohnungen und Ferienhäusern auf der Halbinsel Mönchgut (Rügen), die sich für eine eigene Website und das neue Buchungsportal mit Sprachassistent interessieren. Hinter dem Angebot steht Familie Fries, seit über 20 Jahren selbst Vermieter.
Beginne das Gespräch sofort mit: "${greeting}"
SPRACHEN: Standardsprache ist Deutsch.${lang !== "de" ? ` Dieses Gespräch beginnt auf ${LANGS[lang]}.` : ""} Antworte in der Sprache, in der zuletzt gesprochen wurde.
STIL: herzlich, ruhig, kompetent, wie ein erfahrener Kollege aus der Vermietung – kein Verkaufsdruck. Kurze Antworten (meist ein bis drei Sätze), dann eine passende Rückfrage. Lass dich unterbrechen und hör zu. Siez dein Gegenüber.
Du bist selbst das beste Beispiel: Wenn es passt, sag, dass genau so ein Assistent später auf der Website des Vermieters mit dessen Gästen spricht.
Für alles Konkrete – Angebote, Provisionen, Leistungen, Ablauf, Domain, Vollservice, Hausmeister, Saisonzeiten, Beispiele – delegiere an das Backend und gib dessen Antwort gesprochen wieder. Erfinde keine Preise, Beträge, Termine oder Zusagen. Die festen Jahresgebühren für Portal-Eintrag und Website sind "auf Anfrage"; biete dafür einen Rückruf von Familie Fries an.
RÜCKRUF: Wenn jemand Interesse hat, einen Rückruf oder ein Angebot möchte, frag nacheinander nach Namen, Telefonnummer (wiederhole sie langsam in Zifferngruppen und lass sie bestätigen), gern auch E-Mail-Adresse und wie viele Unterkünfte er hat. Sag dann, dass die Angaben nach dem Gespräch in das Formular "Rückruf oder Nachricht" auf der Seite übernommen werden und er es dort nur noch abschicken muss. Behaupte nie, etwas sei schon abgeschickt.
Wer selbst loslegen möchte: Auf der Seite "Kostenlosen Entwurf erstellen" antippen – in etwa zehn Minuten steht ein erster Entwurf.
Bleib beim Thema Vermietung, Website und Portal auf Mönchgut. Du bist ein KI-Assistent; sag das ehrlich, wenn jemand fragt.`;

const VERMIETER_BACKEND = (kb, brand) => `
Du lieferst Auskünfte für den Sprach-Berater von "${brand}", der mit Vermietern spricht. Antworte knapp und gesprochen-tauglich (keine Tabellen, keine Markdown-Zeichen, Prozent als "zehn Prozent" oder "10 Prozent") in der Sprache der Frage, im Zweifel Deutsch.
Nutze ausschließlich die folgende Wissensbasis. Steht etwas nicht darin (z. B. konkrete Jahresgebühren), sag ehrlich, dass Familie Fries das persönlich beantwortet, und biete einen Rückruf an.

=== WISSENSBASIS ===
${kb}`;

const BACKEND_INSTRUCTIONS = (kb, brand) => `
Du beantwortest Fragen für den Sprachassistenten von "${brand}". Antworte knapp und gesprochen-tauglich (keine Tabellen, keine Markdown-Zeichen, Beträge als "320 Euro") in der Sprache, in der der Gast gefragt hat – Deutsch, Englisch, Schwedisch, Polnisch oder Französisch; im Zweifel Deutsch. Eigennamen nicht übersetzen.
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
    const { sdp, kb, greeting, brand, form, lang, name, voice, address, mode } = body || {};
    const isVermieter = mode === "vermieter";
    const agentName = typeof name === "string" ? name.replace(/[^\p{L} .-]/gu, "").slice(0, 30) : "";
    const voiceName = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"].includes(voice) ? voice : (env.VOICE || "marin");
    const L = LANGS[lang] ? lang : "de";
    if (typeof sdp !== "string" || !sdp.startsWith("v=0") || sdp.length > 20000) return out({ error: "bad sdp" }, 400);
    if (typeof kb !== "string" || kb.length > 30000) return out({ error: "bad kb" }, 400);
    const brandName = (typeof brand === "string" && brand.trim() ? brand : "Ferienwohnungen Mönchgut").slice(0, 80);
    const greet = (L !== "de" ? GREETINGS[L](brandName) : (typeof greeting === "string" ? greeting : "Herzlich willkommen! Wie kann ich Ihnen helfen?")).slice(0, 200);

    const r = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          model: "gpt-live-1",
          instructions: isVermieter ? VERMIETER_INSTRUCTIONS(greet, brandName, L) : LIVE_INSTRUCTIONS(greet, brandName, form === true, L, agentName, address === true),
          audio: { output: { voice: voiceName } },
          delegation: {
            type: "responses",
            responses: {
              model: env.BACKEND_MODEL || "gpt-5.6-terra",
              instructions: isVermieter ? VERMIETER_BACKEND(kb, brandName) : BACKEND_INSTRUCTIONS(kb, brandName),
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

/* ===================== Gemeinsame Herkunftsprüfung ===================== */
function corsFor(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = (origin === "null" && env.ALLOW_FILE === "1") || allowed.length === 0 || allowed.includes(origin);
  const headers = {
    "Access-Control-Allow-Origin": ok ? (origin || "*") : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
  const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
  return { ok, headers, out };
}
const clip = (v, n) => (typeof v === "string" ? v : v == null ? "" : String(v)).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

/* ===================== /extract: Buchungsdaten aus dem Gespräch ===================== */
const EXTRACT_PROMPT = (today, objects) => `Du liest den Verlauf eines Telefon-/Sprachgesprächs zwischen einem Gast und dem Sprachassistenten einer Ferienwohnungs-Vermietung.
Heute ist ${today}. Verfügbare Wohnungen (id: Name): ${objects}.
Gib NUR ein JSON-Objekt zurück, ohne Erklärung, mit genau diesen Feldern (null, wenn der Gast es nicht genannt hat – nichts raten):
{"objekt": id oder null, "anreise": "YYYY-MM-DD" oder null, "abreise": "YYYY-MM-DD" oder null, "personen": Gesamtzahl Personen oder null, "erwachsene": Zahl Erwachsene (ab 18) oder null, "kinder": Zahl Kinder unter 6 oder null, "kinder_alter": [Alter jedes Kindes unter 18] oder null, "hunde": Zahl oder null, "waesche": true/false/null (Bettwäsche/Handtücher gewünscht), "waeschepakete": Anzahl oder null, "babybett": true/false/null, "strandkorb": true/false/null, "name": Text oder null, "strasse": Straße mit Hausnummer oder null, "plz": Postleitzahl als TEXT oder null, "ort": Wohnort oder null, "land": Land (nur wenn genannt) oder null, "kontakt": "email"|"whatsapp"|"telefon"|null (wie der Gast die Antwort bekommen möchte), "telefon": Telefonnummer als TEXT in Anführungszeichen, nur Ziffern und ggf. führendes + (führende Null behalten!) oder null, "email": E-Mail-Adresse kleingeschrieben ohne Leerzeichen oder null, "notiz": kurze Wünsche/Fragen des Gastes auf Deutsch zusammengefasst oder null, "sprache": "de"|"en"|"sv"|"pl"|"fr" (Sprache, in der der Gast überwiegend spricht), "absenden": true/false}
Der Gast kann Deutsch, Englisch, Schwedisch, Polnisch oder Französisch sprechen – Angaben in jeder dieser Sprachen auswerten (z. B. "yes, send it", "ja, skicka", "tak, proszę wysłać", "oui, envoyez"). Regeln: Relative Angaben ("nächsten Freitag", "eine Woche") in echte Daten umrechnen; ohne Jahr das nächste passende Datum in der Zukunft. Gesprochene Zahlen in Ziffern ("null eins sieben eins" -> "0171", "doppel-sieben" -> "77", "plus vier neun" -> "+49"); eine Nummer, die der Gast in mehreren Stücken nennt, zusammensetzen. E-Mail-Adressen aus Buchstabiertem zusammensetzen: "at"/"ät"/"Klammeraffe"/"snabel-a"/"małpa"/"arobase" -> "@", "Punkt"/"dot"/"punkt"/"kropka"/"point" -> ".", "Bindestrich"/"Minus"/"dash" -> "-", "Unterstrich"/"underscore" -> "_", Buchstabiertafel ("D wie Dora") -> "d", Umlaute nur, wenn ausdrücklich so gesagt. Hat der Assistent Nummer oder E-Mail zurückgelesen und der Gast korrigiert oder bestätigt, gilt die bestätigte/korrigierte Fassung. Spätere Korrekturen des Gastes gelten. "absenden" ist nur true, wenn der Assistent gefragt hat, ob die Anfrage abgeschickt werden soll, und der Gast danach eindeutig zugestimmt hat (z. B. "ja, abschicken", "ja bitte"); sonst false.`;

async function handleExtract(req, env) {
  const { ok, headers, out } = corsFor(req, env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return out({ error: "method" }, 405);
  if (!ok) return out({ error: "origin not allowed" }, 403);
  let b; try { b = await req.json(); } catch { return out({ error: "bad json" }, 400); }
  const transcript = clip(b.transcript, 8000);
  if (!transcript) return out({ error: "empty" }, 400);
  const objects = Array.isArray(b.objects) ? b.objects.slice(0, 12).map(o => `${clip(o.id, 40)}: ${clip(o.name, 80)}`).join("; ") : "";
  const system = EXTRACT_PROMPT(clip(b.today, 40) || new Date().toISOString().slice(0, 10), objects);
  let text = "";
  try {
    if (env.ANTHROPIC_KEY) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: env.EXTRACT_MODEL || "claude-haiku-5-5", max_tokens: 600, system, messages: [{ role: "user", content: "GESPRÄCHSVERLAUF:\n" + transcript }] }),
      });
      const d = await r.json();
      if (!r.ok) console.error("extract anthropic", r.status, JSON.stringify(d).slice(0, 300));
      text = (d.content || []).map(c => c.text || "").join("");
    }
    if (!text && env.OPENAI_KEY) {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_KEY}` },
        body: JSON.stringify({ model: env.EXTRACT_MODEL_OPENAI || env.BACKEND_MODEL || "gpt-5.6-terra", instructions: system, input: "GESPRÄCHSVERLAUF:\n" + transcript, text: { format: { type: "json_object" } } }),
      });
      const d = await r.json();
      if (!r.ok) console.error("extract openai", r.status, JSON.stringify(d).slice(0, 300));
      text = d.output_text || (d.output || []).flatMap(o => o.content || []).map(c => c.text || "").join("");
    }
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return out({ error: "no data" }, 502);
    return out({ data: JSON.parse(m[0]) });
  } catch (e) {
    console.error("extract error", e.message);
    return out({ error: "extract failed" }, 502);
  }
}

/* ===================== /anfrage: Gästeanfrage weiterleiten ===================== */
async function handleAnfrage(req, env) {
  const { ok, headers, out } = corsFor(req, env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return out({ error: "method" }, 405);
  if (!ok) return out({ error: "origin not allowed" }, 403);
  let b; try { b = await req.json(); } catch { return out({ error: "bad json" }, 400); }
  const a = {
    brand: clip(b.brand, 80), objekt: clip(b.objekt, 120), anreise: clip(b.anreise, 20), abreise: clip(b.abreise, 20),
    naechte: clip(b.naechte, 4), personen: clip(b.personen, 3), kinder: clip(b.kinder, 3), hunde: clip(b.hunde, 2),
    waesche: clip(b.waesche, 5), extras: clip(b.extras, 60), name: clip(b.name, 100), ort: clip(b.ort, 100),
    telefon: clip(b.telefon, 40), email: clip(b.email, 120), nachricht: clip(b.nachricht, 1500),
    preis: clip(b.preis, 40), quelle: clip(b.quelle, 30), sprache: clip(b.sprache, 20),
    adresse: clip(b.adresse, 200), kontakt: clip(b.kontakt, 20),
  };
  const intl = (t) => { let d = t.replace(/[^\d+]/g, ""); if (d.startsWith("+")) return d.slice(1); if (d.startsWith("00")) return d.slice(2); if (d.startsWith("0")) return "49" + d.slice(1); return d; };
  if (!a.name || !(a.telefon || a.email) || !a.anreise || !a.abreise) return out({ error: "Name, Telefon/E-Mail und Reisedaten fehlen" }, 400);
  const text = [
    `${a.objekt} (${a.brand})`,
    `${a.anreise} – ${a.abreise}${a.naechte ? ` (${a.naechte} Nächte)` : ""}`,
    `${a.personen} Pers.${a.kinder && a.kinder !== "0" ? `, davon ${a.kinder} Kind(er) unter 6` : ""}${a.hunde && a.hunde !== "0" ? `, ${a.hunde} Hund(e)` : ""}`,
    a.waesche === "ja" ? "Wäschepaket: ja" : "", a.extras && a.extras !== "keine" ? `Extras: ${a.extras}` : "",
    a.preis ? `Preis (unverbindlich): ${a.preis}` : "",
    "", a.name, a.adresse || a.ort, a.kontakt ? `Antwort per: ${a.kontakt}` : "", a.telefon ? `Tel. ${a.telefon}` : "", a.email ? a.email : "",
    a.nachricht ? `\n„${a.nachricht}“` : "", `\nQuelle: ${a.quelle || "Webseite"}${a.sprache && a.sprache !== "Deutsch" ? ` · Sprache: ${a.sprache}` : ""}`,
  ].filter(x => x !== "").join("\n");

  const done = [];
  if (env.NTFY_TOPIC) {
    const r = await fetch("https://ntfy.sh/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title: `Neue Anfrage: ${a.name} – ${a.objekt}`, message: text, tags: ["house"], priority: 4,
        actions: [
          a.telefon && a.kontakt === "WhatsApp" ? { action: "view", label: "WhatsApp", url: `https://wa.me/${intl(a.telefon)}` } : null,
          a.telefon ? { action: "view", label: "Anrufen", url: `tel:${a.telefon}` } : null,
          a.email ? { action: "view", label: "E-Mail", url: `mailto:${a.email}` } : null,
        ].filter(Boolean).slice(0, 3) }),
    });
    if (r.ok) done.push("push"); else console.error("ntfy", r.status, await r.text());
  }
  if (env.ANFRAGE_WEBHOOK) {
    const r = await fetch(env.ANFRAGE_WEBHOOK, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "guestbooking", ...a, text }), redirect: "follow" });
    if (r.ok) done.push("tabelle"); else console.error("webhook", r.status);
  }
  if (!done.length) return out({ error: "Weiterleitung nicht eingerichtet (NTFY_TOPIC / ANFRAGE_WEBHOOK fehlen)" }, 503);
  console.log("Anfrage weitergeleitet", done.join("+"), a.objekt, a.anreise);
  return out({ ok: true, via: done });
}

/* ===================== /translate: Seitentexte übersetzen ===================== */
async function sha256(t) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function handleTranslate(req, env, ctx) {
  const { ok, headers, out } = corsFor(req, env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return out({ error: "method" }, 405);
  if (!ok) return out({ error: "origin not allowed" }, 403);
  let b; try { b = await req.json(); } catch { return out({ error: "bad json" }, 400); }
  const lang = b.lang;
  if (!["en", "sv", "pl", "fr"].includes(lang)) return out({ error: "lang" }, 400);
  const texts = Array.isArray(b.texts) ? b.texts.map(t => String(t).slice(0, 2000)) : [];
  if (!texts.length || texts.length > 150 || texts.join("").length > 40000) return out({ error: "size" }, 400);

  const cacheKey = new Request(`https://translate-cache.local/v1/${lang}/${await sha256(JSON.stringify(texts))}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return out(await hit.json());

  const system = `Übersetze Texte einer Ferienwohnungs-Webseite (Halbinsel Mönchgut, Insel Rügen) vom Deutschen ins ${LANGS[lang]}.
Antworte NUR mit einem JSON-Array aus genau ${texts.length} Strings in derselben Reihenfolge wie die Eingabe.
Unverändert lassen: Wohnungs- und Markennamen (z. B. Seglerparadies, Seelenanker, Sonne, Backbord, Sonnensegler, Fürst Jaromar, Inselzeit Mönchgut, Dünenvilla, Strandvilla), Orts- und Straßennamen, Zahlen, Preise, Daten, Uhrzeiten, Telefonnummern, E-Mail-Adressen, Emojis und Symbole. Einzelne Wörter und kurze Beschriftungen kurz übersetzen. Natürlicher, einladender Ton, Anrede höflich.`;
  let arr = null;
  try {
    if (env.ANTHROPIC_KEY) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: env.TRANSLATE_MODEL || env.EXTRACT_MODEL || "claude-haiku-5-5", max_tokens: 8000, system, messages: [{ role: "user", content: JSON.stringify(texts) }] }),
      });
      const d = await r.json();
      if (!r.ok) console.error("translate anthropic", r.status, JSON.stringify(d).slice(0, 300));
      const t = (d.content || []).map(c => c.text || "").join("");
      const m = t.match(/\[[\s\S]*\]/); if (m) arr = JSON.parse(m[0]);
    }
    if (!Array.isArray(arr) && env.OPENAI_KEY) {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_KEY}` },
        body: JSON.stringify({ model: env.EXTRACT_MODEL_OPENAI || env.BACKEND_MODEL || "gpt-5.6-terra", instructions: system + ' Gib das Array als {"t": [...]} zurück.', input: JSON.stringify(texts), text: { format: { type: "json_object" } } }),
      });
      const d = await r.json();
      if (!r.ok) console.error("translate openai", r.status, JSON.stringify(d).slice(0, 300));
      const t = d.output_text || (d.output || []).flatMap(o => o.content || []).map(c => c.text || "").join("");
      const m = t.match(/\{[\s\S]*\}/); if (m) arr = JSON.parse(m[0]).t;
    }
  } catch (e) { console.error("translate error", e.message); }
  if (!Array.isArray(arr) || arr.length !== texts.length) return out({ error: "translate failed" }, 502);
  const result = { texts: arr.map((x, i) => typeof x === "string" ? x : texts[i]) };
  const store = cache.put(cacheKey, new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=2592000" } }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(store); else await store;
  return out(result);
}

/* ===================== /news: Aktuelles auf Mönchgut ===================== */
const NEWS_FEEDS_DEFAULT = [
  "https://news.google.com/rss/search?q=M%C3%B6nchgut%20OR%20Thiessow%20OR%20G%C3%B6hren%20OR%20%22Ostseebad%20M%C3%B6nchgut%22&hl=de&gl=DE&ceid=DE:de",
  "https://news.google.com/rss/search?q=R%C3%BCgen%20Tourismus%20OR%20R%C3%BCgen%20Veranstaltung%20OR%20R%C3%BCgen%20Urlaub&hl=de&gl=DE&ceid=DE:de",
  "https://www.ndr.de/nachrichten/mecklenburg-vorpommern/index-rss.xml",
];
const decodeXml = t => (t || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
async function readFeed(u) {
  try {
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (compatible; InselzeitNews/1.0)" }, cf: { cacheTtl: 1800 } });
    if (!r.ok) return [];
    const x = await r.text();
    return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 30).map(m => {
      const g = tag => { const k = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)); return k ? decodeXml(k[1]) : ""; };
      return { titel: g("title"), url: g("link"), datum: g("pubDate"), quelle: g("source") || new URL(u).hostname.replace(/^www\./, ""), text: g("description").slice(0, 300) };
    }).filter(i => i.titel && /^https:\/\//.test(i.url));
  } catch (e) { console.error("feed", u, e.message); return []; }
}
function seasonOf(d) {
  const m = d.getMonth() + 1, day = d.getDate();
  if (m === 12 || m <= 2) return "winter";
  if (m <= 5) return "fruehling";
  if (m <= 8) return "sommer";
  return "herbst";
}
const NEWS_PROMPT = (today, season) => `Du gestaltest die Rubrik „Aktuelles auf Mönchgut“ einer Ferienwohnungs-Webseite (Halbinsel Mönchgut, Insel Rügen: Thiessow, Gager, Groß und Klein Zicker, Middelhagen, Göhren, Baabe, Sellin).
Heute ist ${today}, Jahreszeit: ${season}.
KURVERWALTUNG: Falls Mails der Kurverwaltung Ostseebad Mönchgut mitgeliefert werden, haben sie Vorrang. Nimm daraus NUR Informationen, die für Gäste öffentlich gedacht sind (Veranstaltungen, Führungen, Konzerte, Märkte, Öffnungszeiten, Strand- und Wegeinfos, Sperrungen, Neuerungen zur Kurkarte). NICHT übernehmen: interne Vermieter-Themen (Meldescheine, Abrechnung, Satzungsänderungen, Fristen für Vermieter, Schulungen), Namen, Telefonnummern oder E-Mail-Adressen von Mitarbeitern. Für diese Meldungen gilt quelle "Kurverwaltung Mönchgut" und url "https://www.ostseebad-moenchgut.de".
Wähle aus den gelieferten Meldungen bis zu 6 aus, die für Urlaubsgäste interessant sind: Veranstaltungen, Feste, Märkte, Konzerte, Natur, Strand, Wetter und Saison, Fähren, Bahn, Bus, Straßensperrungen, Neues in den Orten, Kultur, Gastronomie. NICHT verwenden: Kriminalität, Unfälle, Todesfälle, Politik und Wahlkampf, Streit, Meldungen ohne Bezug zu Rügen.
Schreibe zu jeder Meldung einen eigenen, kurzen Text (1–2 Sätze, max. 220 Zeichen) komplett in deinen eigenen Worten – keine Sätze und keine wörtlichen Formulierungen aus der Quelle übernehmen, keine Zitate. Freundlicher, einladender Ton für Gäste. Erfinde nichts, was nicht in der Meldung steht.
Gib NUR JSON zurück:
{"titel": "kurze Überschrift der Woche (max. 60 Zeichen), passend zu Saison und Meldungen",
 "untertitel": "ein einladender Satz (max. 140 Zeichen)",
 "tipp": {"titel": "Tipp der Woche (max. 50 Zeichen)", "text": "konkreter Ausflugs- oder Erlebnistipp für Mönchgut zu dieser Jahreszeit, 1–2 Sätze, allgemein gültig, ohne erfundene Termine"},
 "meldungen": [{"titel": "eigene kurze Überschrift (max. 70 Zeichen)", "text": "...", "kategorie": "Veranstaltung|Natur|Unterwegs|Ort|Kultur|Genuss", "datum": "YYYY-MM-DD oder null", "quelle": "Name der Quelle", "url": "exakt die URL aus der Eingabe"}]}
Nur Meldungen aus den letzten ca. 3 Wochen oder mit kommenden Terminen. Wenn nichts Passendes dabei ist, gib "meldungen": [] zurück.`;

async function buildNews(env) {
  const now = new Date();
  const today = now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Berlin" });
  const season = seasonOf(now);
  const feeds = (env.NEWS_FEEDS ? env.NEWS_FEEDS.split(/\s*,\s*/) : NEWS_FEEDS_DEFAULT).filter(Boolean);
  const lists = await Promise.all(feeds.map(readFeed));
  const seen = new Set(), items = [];
  for (const it of lists.flat()) { const k = it.titel.toLowerCase().slice(0, 60); if (seen.has(k)) continue; seen.add(k); items.push(it); }
  const recent = items.filter(i => { const t = Date.parse(i.datum); return !t || now - t < 21 * 864e5; }).slice(0, 45);
  const allowed = new Set(recent.map(i => i.url));
  let kur = [];
  if (env.KURMAIL_URL) {
    try {
      const u = env.KURMAIL_URL + (env.KURMAIL_URL.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(env.KURMAIL_TOKEN || "");
      const r = await fetch(u, { redirect: "follow" });
      const d = await r.json();
      if (Array.isArray(d.items)) kur = d.items.slice(0, 8).map(m => ({ betreff: clip(m.betreff, 200), datum: clip(m.datum, 30), text: clip(m.text, 3500), anhaenge: Array.isArray(m.anhaenge) ? m.anhaenge.slice(0, 5).map(a => clip(a, 80)) : [] }));
      else console.error("kurmail", JSON.stringify(d).slice(0, 200));
    } catch (e) { console.error("kurmail error", e.message); }
    if (kur.length) allowed.add("https://www.ostseebad-moenchgut.de");
  }
  const enough = kur.length > 0 || recent.length >= 3;
  const payload = (kur.length ? "MAILS DER KURVERWALTUNG (an Vermieter, neueste zuerst):\n" + JSON.stringify(kur) + "\n\n" : "") + "MELDUNGEN:\n" + JSON.stringify(recent);
  const system = NEWS_PROMPT(today, season);
  let txt = "", web = false;

  try {
    if (enough && env.ANTHROPIC_KEY) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: env.NEWS_MODEL || env.EXTRACT_MODEL || "claude-haiku-5-5", max_tokens: 2500, system, messages: [{ role: "user", content: payload }] }),
      });
      const d = await r.json();
      if (!r.ok) console.error("news anthropic", r.status, JSON.stringify(d).slice(0, 300));
      txt = (d.content || []).map(c => c.text || "").join("");
    }
    if (!txt && env.OPENAI_KEY) {
      web = !enough;
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_KEY}` },
        body: JSON.stringify({
          model: env.NEWS_MODEL_OPENAI || env.BACKEND_MODEL || "gpt-5.6-terra",
          instructions: system + (web ? " Suche selbst im Web nach aktuellen Meldungen zu Mönchgut, Thiessow, Göhren und Rügen (Kurverwaltung Ostseebad Mönchgut, NDR, Ostsee-Zeitung, Nordkurier) und verwende als url die echte Adresse der gefundenen Seite." : ""),
          input: web ? "Finde aktuelle Meldungen und gib das JSON zurück." : payload,
          tools: web ? [{ type: "web_search" }] : undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) console.error("news openai", r.status, JSON.stringify(d).slice(0, 300));
      txt = d.output_text || (d.output || []).flatMap(o => o.content || []).map(c => c.text || "").join("");
    }
  } catch (e) { console.error("news error", e.message); }

  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("news: keine Antwort");
  const j = JSON.parse(m[0]);
  const meldungen = (Array.isArray(j.meldungen) ? j.meldungen : [])
    .filter(x => x && /^https:\/\//.test(x.url) && (web || allowed.has(x.url)))
    .slice(0, 6)
    .map(x => ({ titel: clip(x.titel, 90), text: clip(x.text, 260), kategorie: clip(x.kategorie, 20), datum: /^\d{4}-\d{2}-\d{2}$/.test(x.datum || "") ? x.datum : null, quelle: clip(x.quelle, 60), url: clip(x.url, 600) }));
  return {
    stand: now.toISOString(), saison: season,
    titel: clip(j.titel, 70), untertitel: clip(j.untertitel, 160),
    tipp: j.tipp ? { titel: clip(j.tipp.titel, 60), text: clip(j.tipp.text, 300) } : null,
    meldungen,
  };
}

async function handleNews(req, env, ctx) {
  const { ok, headers, out } = corsFor(req, env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS" } });
  if (req.method !== "GET") return out({ error: "method" }, 405);
  if (!ok) return out({ error: "origin not allowed" }, 403);
  const cache = caches.default;
  const fresh = new Request("https://news-cache.local/v1/fresh"), stale = new Request("https://news-cache.local/v1/stale");
  const save = async data => {
    const body = JSON.stringify(data);
    await cache.put(fresh, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${+env.NEWS_HOURS * 3600 || 43200}` } }));
    await cache.put(stale, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1209600" } }));
  };
  const hit = await cache.match(fresh);
  if (hit) return out(await hit.json());
  const old = await cache.match(stale);
  if (old) {
    const refresh = buildNews(env).then(save).catch(e => console.error("news refresh", e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(refresh);
    return out(await old.json());
  }
  try { const data = await buildNews(env); await save(data); return out(data); }
  catch (e) { console.error("news", e.message); return out({ error: "news unavailable" }, 503); }
}
