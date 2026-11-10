/**
 * Kurverwaltung-Mails → „Aktuelles auf Mönchgut“
 * ------------------------------------------------------------
 * Eigenes, NEUES Apps-Script-Projekt (nicht in die Code.gs von D-Buchung einfügen!).
 * Läuft im Google-Konto, in dessen Gmail die Mails der Kurverwaltung ankommen.
 *
 * Gibt dem Worker NUR Mails der Kurverwaltung (Absender …@ostseebad-moenchgut.de)
 * der letzten 45 Tage zurück – und nur, wenn der geheime Schlüssel stimmt.
 *
 * Einrichtung:
 *  1. script.google.com → Neues Projekt → diesen Text komplett einfügen → Speichern.
 *  2. Oben die Funktion „test“ auswählen → Ausführen → Zugriff auf Gmail erlauben.
 *     Im Ausführungsprotokoll müssen Betreffzeilen der Kurverwaltung erscheinen.
 *  3. Bereitstellen → Neue Bereitstellung → Typ „Web-App“
 *     Ausführen als: Ich · Zugriff: Jeder → Bereitstellen → Web-App-URL kopieren.
 *  4. In Cloudflare (Worker blue-lagune-proxy → Settings → Variables and Secrets) zwei Secrets:
 *     KURMAIL_URL   = die kopierte Web-App-URL (endet auf /exec)
 *     KURMAIL_TOKEN = der Wert von TOKEN unten
 */

const TOKEN = 'RZI1YEaTxEMIlzpqhZFUeBuP';               // geheim – identisch mit KURMAIL_TOKEN in Cloudflare
const ABSENDER = /ostseebad-moenchgut\.de/i;              // nur diese Absender werden weitergegeben
const SUCHE = 'from:(ostseebad-moenchgut.de) newer_than:45d';

function doGet(e) {
  if (!e || !e.parameter || e.parameter.token !== TOKEN) return json_({ error: 'forbidden' });
  return json_({ items: kurMails_() });
}

function kurMails_() {
  const items = [];
  GmailApp.search(SUCHE, 0, 20).forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      if (!ABSENDER.test(m.getFrom())) return;              // Antworten anderer Absender im Verlauf überspringen
      const text = (m.getPlainBody() || '')
        .replace(/\r/g, '')
        .replace(/^>.*$/gm, '')                             // zitierte Altmails entfernen
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 4000);
      items.push({
        betreff: m.getSubject(),
        datum: m.getDate().toISOString(),
        text: text,
        anhaenge: m.getAttachments().map(function (a) { return a.getName(); })
      });
    });
  });
  items.sort(function (a, b) { return b.datum.localeCompare(a.datum); });
  return items.slice(0, 10);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** Zum Ausprobieren im Editor: zeigt, was der Worker bekommen würde. */
function test() {
  const list = kurMails_();
  Logger.log(list.length + ' Mail(s) der Kurverwaltung gefunden');
  list.forEach(function (m) { Logger.log(m.datum.slice(0, 10) + ' – ' + m.betreff + (m.anhaenge.length ? ' [Anhänge: ' + m.anhaenge.join(', ') + ']' : '')); });
}
