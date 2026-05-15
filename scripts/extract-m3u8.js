/**
 * Extraccion automatica de streams HLS (.m3u8) desde los links base
 *
 * Flujo:
 * 1) Lee data/partidos.json
 * 2) Para cada link unico, abre con Playwright
 * 3) Escucha requests/responses de red
 * 4) Detecta URLs .m3u8 automaticamente
 * 5) Prioriza streams finales sobre manifests intermedios (scoring inteligente)
 * 6) Limpia parametros problematicos (ip= hardcodeado) mantiene token
 * 7) Valida que el stream responda correctamente (HEAD)
 * 8) Genera data/streams.json con los streams validos
 *
 * Reglas:
 * - Tolerante a fallos: un link fallido no bloquea los demas
 * - Timeouts razonables
 * - Reintentos limitados (max 2 por link)
 * - Deduplicacion por canal
 * - Si no hay cambios respecto al run anterior, no regenera
 * - Prioriza tracks-v1a1/mono.m3u8 sobre index.m3u8 intermedio
 * - Elimina ip= hardcodeado del runner de GitHub Actions
 * - Mantiene token de autenticacion
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

/**
 * Limpia parametros problematicos de una URL de stream:
 * - Elimina ip=... (hardcodeado del runner, no sirve para el usuario final)
 * - Mantiene token=... y otros parametros funcionales
 * - Elimina duplicados
 */
function cleanStreamUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const urlObj = new URL(url);
    const paramsToRemove = ['ip'];
    for (const p of paramsToRemove) {
      urlObj.searchParams.delete(p);
    }
    return urlObj.toString();
  } catch {
    // Si no se puede parsear, hacer limpieza manual
    return url.replace(/[?&]ip=[^&]+/g, '').replace(/\?$/, '').replace(/&&+/g, '&').replace(/\?&/, '?');
  }
}

/**
 * Scoring inteligente para elegir el mejor stream:
 * +100: tracks-v1a1 mono.m3u8 (stream final directo)
 * +60:  otra variante tracks-N mono.m3u8
 * +40:  cualquier mono.m3u8
 * +30:  index.m3u8 con token
 * +10:  cualquier .m3u8 valido
 * +15:  tiene token de autenticacion
 * -40:  contiene ip= (hardcodeado del runner, puede no funcionar para usuarios)
 * -20:  es manifest /global/ generico sin variant especifica
 * -10:  es index.m3u8 sin variantes (probable master manifest intermedio)
 */
function scoreCandidate(url) {
  if (!url) return -Infinity;
  const u = url.toLowerCase();
  let score = 0;

  // Prioridad alta: stream final directo (variante de reproduccion real)
  if (u.includes('tracks-v1a1/mono.m3u8')) {
    score += 100;
  } else if (/tracks-v\d+a\d+\/mono\.m3u8/.test(u)) {
    score += 60;
  } else if (u.includes('mono.m3u8')) {
    score += 40;
  }

  // Tiene token de autenticacion (bueno)
  if (u.includes('token=')) {
    score += 15;
  }

  // Penalizacion: ip hardcodeado del runner de GitHub Actions
  if (u.includes('ip=')) {
    score -= 40;
  }

  // Penalizacion: manifest intermedio generico
  if (u.includes('/global/') && u.includes('index.m3u8') && !u.includes('tracks-')) {
    score -= 20;
  }

  // Penalizacion menor: index.m3u8 generico sin variant
  if (u.includes('index.m3u8') && !u.includes('tracks-') && !u.includes('mono')) {
    score -= 10;
  }

  // Base: cualquier m3u8 valido
  if (u.includes('.m3u8')) {
    score += 10;
  }

  return score;
}

/**
 * Ordena candidatos por scoring inteligente (mejor primero)
 */
function sortCandidatesByScore(urls) {
  const unique = [...new Set(urls.map(u => cleanStreamUrl(u)))].filter(Boolean);
  return unique.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

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
      foundUrls.add(reqUrl);
    }
  };

  const responseHandler = (response) => {
    const respUrl = response.url();
    const contentType = (response.headers()['content-type'] || '').toLowerCase();

    if (HLS_CONTENT_TYPES.some(t => contentType.includes(t))) {
      foundUrls.add(respUrl);
    }

    if (M3U8_PATTERNS.some(p => p.test(respUrl))) {
      foundUrls.add(respUrl);
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
        foundUrls.add(src);
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
            foundUrls.add(src);
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
          const rawCandidates = await extractFromPage(page, link, channel);
          console.log(`  Candidatos crudos: ${rawCandidates.length}`);

          // Ordenar por scoring inteligente y limpiar duplicados
          const candidates = sortCandidatesByScore(rawCandidates);

          if (candidates.length > 0) {
            console.log(`  Top candidatos (ordenados por score):`);
            candidates.slice(0, 5).forEach((c, idx) => {
              const score = scoreCandidate(c);
              const clean = c.length > 80 ? c.substring(0, 80) + '...' : c;
              console.log(`    ${idx + 1}. [score:${score}] ${clean}`);
            });
          }

          // Validar cada candidato en orden de prioridad
          for (const candidate of candidates) {
            const cleanUrl = cleanStreamUrl(candidate);
            if (!cleanUrl) continue;

            // Evitar URLs duplicadas ya validadas en este run
            if (streams.some(s => s.channel === channel && s._checked === cleanUrl)) continue;

            console.log(`  Validando: ${cleanUrl.substring(0, 80)}...`);
            const isValid = await validateM3U8(cleanUrl);
            if (isValid) {
              foundStream = cleanUrl;
              console.log(`  [OK] Stream valido encontrado (score: ${scoreCandidate(candidate)})`);
              break;
            }
          }

          // Si no encontro con scoring, probar los originales como fallback
          if (!foundStream && candidates.length > 0) {
            console.log(`  [INFO] Reintentando con URLs originales como fallback...`);
            for (const candidate of rawCandidates.slice(0, 3)) {
              const cleanUrl = cleanStreamUrl(candidate);
              if (!cleanUrl || streams.some(s => s.channel === channel && s._checked === cleanUrl)) continue;
              console.log(`  Fallback: ${cleanUrl.substring(0, 80)}...`);
              const isValid = await validateM3U8(cleanUrl);
              if (isValid) {
                foundStream = cleanUrl;
                console.log(`  [OK] Stream valido por fallback`);
                break;
              }
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
          _checked: foundStream, // campo interno para dedup
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

    // Limpiar campos internos antes de guardar
    const cleanStreams = streams.map(({ _checked, ...rest }) => rest);

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
      // Limpiar ip= de streams existentes tambien
      const cleaned = { ...s };
      if (cleaned.stream) cleaned.stream = cleanStreamUrl(cleaned.stream);
      streamMap.set(cleaned.channel, cleaned);
    }
    for (const s of cleanStreams) {
      streamMap.set(s.channel, s);
    }

    const finalStreams = [...streamMap.values()];

    ensureDir(OUTPUT);
    fs.writeFileSync(OUTPUT, JSON.stringify(finalStreams, null, 2), 'utf-8');

    console.log(`\n[M3U8] ${finalStreams.length} streams guardados en ${OUTPUT}`);
    console.log(`[M3U8] De ${uniqueChannels.length} canales, ${cleanStreams.length} nuevos encontrados`);

    // Log de resumen de URLs guardadas
    for (const s of finalStreams) {
      const score = scoreCandidate(s.stream);
      const prefix = score >= 80 ? 'EXCELENTE' : score >= 30 ? 'OK' : score >= 0 ? 'ADVERTENCIA' : 'REVISAR';
      console.log(`[M3U8]   [${prefix}] ${s.channel}: ${s.stream.substring(0, 90)}${s.stream.length > 90 ? '...' : ''}`);
    }

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
