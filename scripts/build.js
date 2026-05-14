/**
 * Genera index.html a partir de los datos scrapeados
 * Lee data/partidos.json, data/escudos.json y data/streams.json, inyecta en template.html
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TEMPLATE = path.join(__dirname, '..', 'template.html');
const OUTPUT = path.join(__dirname, '..', 'index.html');

function loadJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.warn(`[Build] Advertencia: ${filename} no encontrado, usando datos vacios`);
    return [];
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

function formatJSArray(items, indent = 2) {
  if (items.length === 0) return '[]';

  const spaces = ' '.repeat(indent);
  const lines = items.map(item => {
    const props = Object.entries(item)
      .map(([k, v]) => {
        const val = typeof v === 'string' ? `"${v.replace(/"/g, '\\"')}"` : v;
        return `${k}: ${val}`;
      })
      .join(', ');
    return `${spaces}{ ${props} }`;
  });

  return `[\n${lines.join(',\n')}\n${' '.repeat(indent - 2)}]`;
}

function generateBuildTime() {
  const now = new Date();
  const pad = n => n.toString().padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function build() {
  console.log('[Build] Generando index.html...');

  // Cargar datos
  const partidos = loadJSON('partidos.json');
  const escudos = loadJSON('escudos.json');
  const streams = loadJSON('streams.json');

  console.log(`[Build] Partidos: ${partidos.length} canales`);
  console.log(`[Build] Escudos: ${escudos.length} partidos`);
  console.log(`[Build] Streams: ${streams.length} canales`);

  // Cargar template
  if (!fs.existsSync(TEMPLATE)) {
    console.error('[Build] Error: template.html no encontrado');
    process.exit(1);
  }
  let html = fs.readFileSync(TEMPLATE, 'utf-8');

  // Reemplazar marcadores
  html = html.replace(/\/\/ {{EVENTS_DATA}}\nconst eventsData = \[\];/, `const eventsData = ${formatJSArray(partidos)};`);
  html = html.replace(/\/\/ {{LOGOS_DATA}}\nconst matchesLogos = \[\];/, `const matchesLogos = ${formatJSArray(escudos)};`);
  html = html.replace(/\/\/ {{STREAMS_DATA}}\nconst streamsData = \[\];/, `const streamsData = ${formatJSArray(streams)};`);
  html = html.replace('{{BUILD_TIME}}', generateBuildTime());
  html = html.replace('{{EVENTS_COUNT}}', partidos.length.toString());
  html = html.replace('{{LOGOS_COUNT}}', escudos.length.toString());
  html = html.replace('{{STREAMS_COUNT}}', streams.length.toString());

  // Guardar
  fs.writeFileSync(OUTPUT, html, 'utf-8');
  console.log('[Build] index.html generado correctamente en', OUTPUT);
  console.log('[Build] Ultima actualizacion:', generateBuildTime());
}

build();
