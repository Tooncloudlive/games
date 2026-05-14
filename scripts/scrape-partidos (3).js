/**
 * Scraping de partidos desde streamx550.com
 * Extrae:
 * - hora
 * - nombre del partido
 * - enlaces de canales
 *
 * Si falla el scraping o no hay eventos:
 * - guarda [] en partidos.json
 * - NO rompe GitHub Actions
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://streamx550.com/';
const OUTPUT = path.join(__dirname, '..', 'data', 'partidos.json');

// Ajustes horarios
const SOURCE_OFFSET = 0;
const TARGET_OFFSET = 0;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveEmptyJson() {
  ensureDir(OUTPUT);

  fs.writeFileSync(
    OUTPUT,
    JSON.stringify([], null, 2),
    'utf-8'
  );

  console.log('[Partidos] JSON vacío guardado');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseTimeToMinutes(timeStr) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(
    String(timeStr).trim()
  );

  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return hours * 60 + minutes;
}

function convertTimeToGMT3(timeStr) {
  const minutes = parseTimeToMinutes(timeStr);

  if (minutes === null) return timeStr;

  const offsetDiff = TARGET_OFFSET - SOURCE_OFFSET;

  let converted = minutes + offsetDiff * 60;

  converted = ((converted % 1440) + 1440) % 1440;

  const hours = Math.floor(converted / 60);
  const mins = converted % 60;

  return `${pad2(hours)}:${pad2(mins)}`;
}

// Script que se ejecuta dentro del navegador
const SCRAPE_SCRIPT = () => {

  const eventsData = [];

  document.querySelectorAll('.event').forEach(eventEl => {

    const nameText =
      eventEl
        .querySelector('.event-name')
        ?.innerText
        ?.trim();

    if (!nameText) return;

    const timeMatch =
      nameText.match(/^(\d{1,2}:\d{2})\s*-\s*(.*)$/);

    if (!timeMatch) return;

    const time = timeMatch[1];
    const match = timeMatch[2].trim();

    eventEl
      .querySelectorAll('.iframe-link')
      .forEach(input => {

        let link = input.value;

        if (!link) return;

        // Reemplazo automático
        link = link.replace(
          'global1.php',
          'global2.php'
        );

        eventsData.push({
          time,
          match,
          link
        });

      });

  });

  return eventsData;
};

async function scrapePartidos() {

  console.log('[Partidos] Iniciando scraping de', URL);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const context = await browser.newContext({
    timezoneId: 'America/Argentina/Buenos_Aires',
    locale: 'es-AR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {

    await page.goto(URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Esperar renderizado
    await page.waitForTimeout(5000);

    // Verificar si hay eventos
    const hasEvents = await page.$('.event');

    if (!hasEvents) {

      console.log('[Partidos] No hay eventos disponibles');

      saveEmptyJson();

      return;
    }

    let eventsData =
      await page.evaluate(SCRAPE_SCRIPT);

    // Si no encontró nada
    if (!eventsData || eventsData.length === 0) {

      console.log('[Partidos] No se encontraron partidos');

      saveEmptyJson();

      return;
    }

    // Convertir horarios
    eventsData = eventsData.map(event => ({
      ...event,
      time: convertTimeToGMT3(event.time)
    }));

    // Eliminar duplicados
    const uniqueMap = new Map();

    for (const event of eventsData) {

      const key =
        `${event.time}-${event.match}-${event.link}`;

      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, event);
      }
    }

    eventsData = [...uniqueMap.values()];

    // Ordenar por hora
    eventsData.sort((a, b) =>
      a.time.localeCompare(b.time)
    );

    console.log(
      `[Partidos] Encontrados ${eventsData.length} canales`
    );

    // Crear carpeta
    ensureDir(OUTPUT);

    // Guardar JSON
    fs.writeFileSync(
      OUTPUT,
      JSON.stringify(eventsData, null, 2),
      'utf-8'
    );

    console.log(
      '[Partidos] Datos guardados en',
      OUTPUT
    );

    // Resumen
    const partidosUnicos =
      new Set(
        eventsData.map(e => e.match)
      ).size;

    console.log(
      `[Partidos] ${partidosUnicos} partidos únicos`
    );

  } catch (error) {

    console.warn(
      '[Partidos] Error durante scraping:',
      error.message
    );

    // Fallback
    saveEmptyJson();

    // NO romper GitHub Actions
    process.exitCode = 0;

  } finally {

    await browser.close();

  }
}

scrapePartidos().catch(error => {

  console.warn(
    '[Partidos] Error inesperado:',
    error.message
  );

  saveEmptyJson();

  process.exitCode = 0;

});
