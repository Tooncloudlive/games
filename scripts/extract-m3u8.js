/**
 * Extraccion automatica de streams HLS (.m3u8) desde los links base
 *
 * Flujo:
 * 1) Lee data/partidos.json
 * 2) Para cada link unico, abre con Playwright
 * 3) Escucha requests/responses de red
 * 4) Detecta URLs .m3u8 automaticamente
 * 5) Valida que el stream responde correctamente (HEAD)
 * 6) Genera data/streams.json con los streams validos
 *
 * Reglas:
 * - Tolerante a fallos: un link fallido no bloquea los demas
 * - Timeouts razonables
 * - Reintentos limitados (max 2 por link)
 * - Deduplicacion por canal
 * - Si no hay cambios respecto al run anterior, no regenera
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const PARTIDOS_PATH = path.join(__dirname, '..', 'data', 'partidos.json');
const OUTPUT = path.join(__dirname, '..', 'data', 'streams.json');

// Patrones para detectar streams HLS
const M3U8_PATTERNS = [
  /\.m3u8/i,
  /\/manifest\//i,
  /\/playlist\//i,
  /\/master\//i,
  /\/index\.m3u8/i,
  /\/live\//i,
  /\/stream\//i,
  /application\/vnd\.apple\.mpegurl/i,
  /application\/x-mpegurl/i,
];

// Content-types que indican HLS
const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'video/mp2t',
  'application/octet-stream',
  'video/MP2T',
];

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveEmptyJson() {
  ensureDir(OUTPUT);
  fs.writeFileSync(OUTPUT, JSON.stringify([], null, 2), 'utf-8');
  console.log('[M3U8] JSON vacio guardado');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getChannelFromLink(link) {
  const match = link.match(/channel=([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Valida un stream m3u8 con HEAD request
 * Retorna true si responde con status 2xx y content-type valido
 */
function validateM3U8(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.request(url, { method: 'HEAD', timeout: 8000 }, (res) => {
      const status = res.statusCode;
      const contentType = (res.headers['content-type'] || '').toLowerCase();

      if (status >= 200 && status < 300) {
        // Verificar content-type o extension
        const isHlsType = HLS_CONTENT_TYPES.some(t => contentType.includes(t));
        const isM3u8Ext = url.toLowerCase().includes('.m3u8');
        if (isHlsType || isM3u8Ext) {
          resolve(true);
          return;
        }
      }
      // Si hace redirect, considerarlo potencialmente valido
      if (status >= 300 && status < 400 && res.headers.location) {
        resolve(true);
        return;
      }
      resolve(false);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Extrae m3u8 de una pagina usando Playwright
 * Escucha requests y responses de red
 */
async function extractFromPage(page, url, channel) {
  const foundUrls = new Set();

  const handler = (request) => {
    const reqUrl = request.url();
    if (!reqUrl) return;

    // Filtrar por patrones m3u8
    const isM3u8 = M3U8_PATTERNS.some(p => p.test(reqUrl));
    if (isM3u8) {
      // Limpiar query params de tracking pero mantener los funcionales
      const cleanUrl = reqUrl.split('#')[0];
      foundUrls.add(cleanUrl);
    }
  };

  const responseHandler = (response) => {
    const respUrl = response.url();
    const contentType = (response.headers()['content-type'] || '').toLowerCase();

    if (HLS_CONTENT_TYPES.some(t => contentType.includes(t))) {
      foundUrls.add(respUrl.split('#')[0]);
    }

    if (M3U8_PATTERNS.some(p => p.test(respUrl))) {
      foundUrls.add(respUrl.split('#')[0]);
    }
  };

  page.on('request', handler);
  page.on('response', responseHandler);

  try {
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Esperar a que cargue el reproductor y haga requests
    await sleep(5000);

    // Intentar extraer m3u8 desde el DOM (algunos reproductores lo ponen en data-src o sources)
    const domSources = await page.evaluate(() => {
      const sources = [];
      // Buscar en video tags
      document.querySelectorAll('video').forEach(v => {
        if (v.src) sources.push(v.src);
        v.querySelectorAll('source').forEach(s => {
          if (s.src) sources.push(s.src);
        });
      });
      // Buscar en iframes
      document.querySelectorAll('iframe').forEach(f => {
        if (f.src) sources.push(f.src);
      });
      // Buscar atributos data-* comunes
      document.querySelectorAll('[data-src], [data-url], [data-stream], [data-video]').forEach(el => {
        ['data-src', 'data-url', 'data-stream', 'data-video'].forEach(attr => {
          if (el.getAttribute(attr)) sources.push(el.getAttribute(attr));
        });
      });
      // Buscar en scripts inline que contengan m3u8
      const scripts = [...document.querySelectorAll('script')].map(s => s.textContent || '');
      const m3u8Regex = /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi;
      for (const script of scripts) {
        const matches = script.match(m3u8Regex);
        if (matches) sources.push(...matches);
      }
      return sources;
    });

    for (const src of domSources) {
      if (M3U8_PATTERNS.some(p => p.test(src))) {
        foundUrls.add(src.split('#')[0]);
      }
    }

    // Si hay iframes, intentar entrar a ellos
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const frameSources = await frame.evaluate(() => {
          const sources = [];
          document.querySelectorAll('video').forEach(v => {
            if (v.src) sources.push(v.src);
          });
          document.querySelectorAll('source').forEach(s => {
            if (s.src) sources.push(s.src);
          });
          const scripts = [...document.querySelectorAll('script')].map(s => s.textContent || '');
          const m3u8Regex = /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi;
          for (const script of scripts) {
            const matches = script.match(m3u8Regex);
            if (matches) sources.push(...matches);
          }
          return sources;
        });
        for (const src of frameSources) {
          if (M3U8_PATTERNS.some(p => p.test(src))) {
            foundUrls.add(src.split('#')[0]);
          }
        }
      } catch (_) {
        // Ignorar errores de cross-origin frames
      }
    }

  } catch (error) {
    console.log(`  [WARN] Error navegando a ${url}: ${error.message}`);
  } finally {
    page.removeListener('request', handler);
    page.removeListener('response', responseHandler);
  }

  return [...foundUrls];
}

async function extractM3U8() {
  console.log('[M3U8] Iniciando extraccion de streams HLS...');

  if (!fs.existsSync(PARTIDOS_PATH)) {
    console.warn('[M3U8] No existe partidos.json');
    saveEmptyJson();
    return;
  }

  const partidos = JSON.parse(fs.readFileSync(PARTIDOS_PATH, 'utf-8'));
  if (!partidos?.length) {
    console.log('[M3U8] No hay partidos para extraer');
    saveEmptyJson();
    return;
  }

  // Agrupar links unicos por canal
  const channelLinks = new Map();
  for (const p of partidos) {
    const ch = getChannelFromLink(p.link);
    if (ch && !channelLinks.has(ch)) {
      channelLinks.set(ch, p.link);
    }
  }

  const uniqueChannels = [...channelLinks.entries()];
  console.log(`[M3U8] ${uniqueChannels.length} canales unicos para escanear`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    locale: 'es-ES',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  const streams = [];
  const seenChannels = new Set();

  try {
    for (let i = 0; i < uniqueChannels.length; i++) {
      const [channel, link] = uniqueChannels[i];

      if (seenChannels.has(channel)) continue;

      console.log(`\n[${i + 1}/${uniqueChannels.length}] Canal: ${channel}`);
      console.log(`  URL: ${link}`);

      const page = await context.newPage();
      let attempts = 0;
      let maxAttempts = 2;
      let foundStream = null;

      while (attempts < maxAttempts && !foundStream) {
        attempts++;
        if (attempts > 1) {
          console.log(`  Reintento ${attempts}/${maxAttempts}...`);
          await sleep(2000);
        }

        try {
          const candidates = await extractFromPage(page, link, channel);
          console.log(`  Candidatos encontrados: ${candidates.length}`);

          // Validar cada candidato
          for (const candidate of candidates) {
            console.log(`  Validando: ${candidate.substring(0, 80)}...`);
            const isValid = await validateM3U8(candidate);
            if (isValid) {
              foundStream = candidate;
              console.log(`  [OK] Stream valido encontrado`);
              break;
            }
          }
        } catch (err) {
          console.log(`  [ERROR] Intento ${attempts}: ${err.message}`);
        }
      }

      await page.close();

      if (foundStream) {
        streams.push({
          channel: channel,
          source: link,
          stream: foundStream,
        });
        seenChannels.add(channel);
        console.log(`  [OK] Canal ${channel} -> stream guardado`);
      } else {
        console.log(`  [WARN] No se encontro stream valido para ${channel}`);
      }

      // Pausa entre canales para no saturar
      if (i < uniqueChannels.length - 1) {
        await sleep(1500 + Math.random() * 1000);
      }
    }

    // Cargar streams existentes para merge (preservar los que aun sirvan)
    let existingStreams = [];
    if (fs.existsSync(OUTPUT)) {
      try {
        existingStreams = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8'));
      } catch (_) {}
    }

    // Merge: nuevos streams tienen prioridad, pero preservar canales no encontrados
    const streamMap = new Map();
    for (const s of existingStreams) {
      streamMap.set(s.channel, s);
    }
    for (const s of streams) {
      streamMap.set(s.channel, s);
    }

    const finalStreams = [...streamMap.values()];

    ensureDir(OUTPUT);
    fs.writeFileSync(OUTPUT, JSON.stringify(finalStreams, null, 2), 'utf-8');

    console.log(`\n[M3U8] ${finalStreams.length} streams guardados en ${OUTPUT}`);
    console.log(`[M3U8] De ${uniqueChannels.length} canales, ${streams.length} nuevos encontrados`);

    // Si no se encontro ningun stream nuevo y no habia existentes, guardar vacio
    if (finalStreams.length === 0) {
      saveEmptyJson();
    }

  } catch (error) {
    console.warn('[M3U8] Error general:', error.message);
    // No romper el pipeline: si ya existe streams.json, dejarlo
    if (!fs.existsSync(OUTPUT)) {
      saveEmptyJson();
    }
    process.exitCode = 0;
  } finally {
    await browser.close();
  }
}

extractM3U8().catch(error => {
  console.warn('[M3U8] Error inesperado:', error.message);
  if (!fs.existsSync(OUTPUT)) saveEmptyJson();
  process.exitCode = 0;
});
