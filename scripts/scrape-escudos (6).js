/**
 * Scraping robusto de escudos desde Flashscore
 *
 * Flujo:
 * 1) Lee data/partidos.json
 * 2) Intenta resolver la URL del partido en Flashscore
 * 3) Extrae logos desde la página del partido con varias estrategias
 * 4) Si falta uno de los escudos, busca la página del equipo individualmente
 * 5) Guarda resultados parciales en data/escudos.json sin romper el pipeline
 *
 * Mejoras respecto al script original:
 * - Búsqueda del partido con varias consultas y ranking de resultados
 * - Extracción más flexible desde scripts, globals y DOM
 * - Fallback individual solo para los equipos que faltan
 * - Cache normalizada por equipo para evitar búsquedas repetidas
 * - No congela null como resultado definitivo para un equipo
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PARTIDOS_PATH = path.join(__dirname, '..', 'data', 'partidos.json');
const OUTPUT = path.join(__dirname, '..', 'data', 'escudos.json');
const GOOGLE_SEARCH_URL = 'https://www.google.com/search?q=';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveEmptyJson() {
  ensureDir(OUTPUT);
  fs.writeFileSync(OUTPUT, JSON.stringify([], null, 2), 'utf-8');
  console.log('[Escudos] JSON vacío guardado');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeTeamKey(value) {
  return normalizeText(value);
}

function cleanTeamNameForSearch(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[\[\]{}<>“”"'`´]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ej:
 * "Copa Libertadores: Mirassol vs LDU Quito"
 */
function extractTeamNames(matchText) {
  if (!matchText) return [null, null];

  const withoutCompetition = matchText.replace(/^[^:]+:\s*/, '');
  const vsMatch = withoutCompetition.match(/(.+?)\s+vs\.?\s+(.+)/i);

  if (!vsMatch) return [null, null];

  return [vsMatch[1].trim(), vsMatch[2].trim()];
}

async function isGoogleBlocked(page) {
  return page.evaluate(() => {
    const title = document.title.toLowerCase();
    const body = document.body?.innerText?.toLowerCase() || '';

    return (
      title.includes('captcha') ||
      title.includes('unusual traffic') ||
      body.includes('captcha') ||
      body.includes('unusual traffic') ||
      body.includes('automated requests') ||
      body.includes("i'm not a robot") ||
      body.includes('no soy un robot') ||
      !!document.querySelector('#captcha') ||
      !!document.querySelector('form[action*="captcha"]')
    );
  });
}

function scoreSearchResult(result, teamA, teamB, pathHint = 'match') {
  const href = result.href || '';
  const text = `${result.text || ''} ${result.aria || ''} ${result.title || ''} ${href}`;
  const norm = normalizeText(text);
  const a = normalizeText(teamA);
  const b = normalizeText(teamB);

  let score = 0;

  if (!norm.includes('flashscore')) return -9999;

  if (/\/match\//i.test(href) || /\/partido\//i.test(href)) score += 40;
  if (/\/team\//i.test(href) || /\/equipo\//i.test(href)) score += 30;
  if (/\/h2h\//i.test(href) || /\/odds\//i.test(href) || /\/standings\//i.test(href) || /\/clasificacion\//i.test(href) || /\/news\//i.test(href)) {
    score -= 40;
  }

  if (pathHint === 'match' && (/\/match\//i.test(href) || /\/partido\//i.test(href))) score += 50;
  if (pathHint === 'team' && (/\/team\//i.test(href) || /\/equipo\//i.test(href))) score += 60;

  if (a && norm.includes(a)) score += 35;
  if (b && norm.includes(b)) score += 35;

  const aTokens = a.split(' ').filter(Boolean);
  const bTokens = b.split(' ').filter(Boolean);

  const aHits = aTokens.filter(t => t.length > 2 && norm.includes(t)).length;
  const bHits = bTokens.filter(t => t.length > 2 && norm.includes(t)).length;

  score += aHits * 8;
  score += bHits * 8;

  if (a && b && norm.includes(a) && norm.includes(b)) score += 40;

  return score;
}

async function googleCandidates(page, query) {
  const searchUrl = `${GOOGLE_SEARCH_URL}${encodeURIComponent(query)}&hl=es&num=10`;

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);

    if (await isGoogleBlocked(page)) {
      console.log('  [BLOQUEO] Google detectó bot');
      return [];
    }

    return await page.evaluate(() => {
      return [...document.querySelectorAll('a[href]')]
        .map(a => ({
          href: a.href || '',
          text: (a.innerText || a.textContent || '').trim(),
          aria: (a.getAttribute('aria-label') || '').trim(),
          title: (a.getAttribute('title') || '').trim(),
        }))
        .filter(x => x.href && !x.href.startsWith('javascript:'));
    });
  } catch (error) {
    console.log(`  [ERROR] Google query falló: ${error.message}`);
    return [];
  }
}

async function findFlashscoreUrl(page, queries, teamA, teamB, pathHint = 'match') {
  const seen = new Set();
  let best = null;
  let bestScore = -Infinity;

  for (const query of queries) {
    const results = await googleCandidates(page, query);

    for (const result of results) {
      const href = result.href || '';
      if (!href || seen.has(href)) continue;
      seen.add(href);

      if (!/flashscore/i.test(href)) continue;

      const score = scoreSearchResult(result, teamA, teamB, pathHint);
      if (score > bestScore) {
        bestScore = score;
        best = href;
      }
    }

    if (bestScore >= 120) break;
  }

  return best;
}

function buildMatchQueries(homeTeam, awayTeam) {
  const home = cleanTeamNameForSearch(homeTeam);
  const away = cleanTeamNameForSearch(awayTeam);

  return [
    `${home} vs ${away} flashscore`,
    `${away} vs ${home} flashscore`,
    `site:flashscore.com.ar "${home}" "${away}"`,
    `site:flashscore.es "${home}" "${away}"`,
    `site:flashscore.com "${home}" "${away}"`,
    `flashscore ${home} ${away}`,
  ];
}

function buildTeamQueries(teamName) {
  const team = cleanTeamNameForSearch(teamName);

  return [
    `site:flashscore.com.ar/team/ "${team}"`,
    `site:flashscore.es/team/ "${team}"`,
    `site:flashscore.com/team/ "${team}"`,
    `flashscore team ${team}`,
    `"${team}" flashscore`,
  ];
}

function pickBestCandidate(candidates, teamName, excludeLogo = null) {
  const target = normalizeText(teamName);
  let best = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const logo = candidate.logo || '';
    if (!logo) continue;
    if (excludeLogo && logo === excludeLogo) continue;

    const name = normalizeText(candidate.name || '');
    const alt = normalizeText(candidate.alt || '');
    const context = normalizeText(candidate.context || '');
    const combined = normalizeText(`${name} ${alt} ${context} ${logo}`);

    let score = 0;

    if (name === target) score += 120;
    if (alt === target) score += 110;
    if (context === target) score += 100;

    if (name && (name.includes(target) || target.includes(name))) score += 70;
    if (alt && (alt.includes(target) || target.includes(alt))) score += 60;
    if (context && (context.includes(target) || target.includes(context))) score += 45;

    const tokens = target.split(' ').filter(Boolean);
    const hits = tokens.filter(t => t.length > 2 && combined.includes(t)).length;
    score += hits * 8;

    if (/logo|badge|crest|shield|escudo/i.test(logo)) score += 4;

    if (score > bestScore) {
      bestScore = score;
      best = logo;
    }
  }

  return best;
}

async function extractLogoCandidatesFromFlashscore(page) {
  return page.evaluate(() => {
    const candidates = [];
    const seen = new Set();

    function normalizeText(value) {
      return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
    }

    function addCandidate(candidate) {
      if (!candidate || !candidate.logo) return;
      const logo = String(candidate.logo).trim();
      if (!/^https?:\/\//i.test(logo)) return;

      const key = `${logo}::${candidate.name || ''}::${candidate.alt || ''}::${candidate.context || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({
        logo,
        name: candidate.name || '',
        alt: candidate.alt || '',
        context: candidate.context || '',
      });
    }

    function getTextSnippet(el) {
      if (!el) return '';
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return text.slice(0, 160);
    }

    function safeValue(v) {
      return typeof v === 'string' ? v : (v == null ? '' : String(v));
    }

    function logoFromObject(obj) {
      if (!obj || typeof obj !== 'object') return '';
      return (
        obj.image_path ||
        obj.small_image_path ||
        obj.image ||
        obj.logo ||
        obj.badge ||
        obj.icon ||
        obj.src ||
        ''
      );
    }

    function nameFromObject(obj) {
      if (!obj || typeof obj !== 'object') return '';
      return (
        obj.name ||
        obj.shortName ||
        obj.teamName ||
        obj.fullName ||
        obj.title ||
        obj.participantName ||
        ''
      );
    }

    function walk(node, depth = 0, maxDepth = 7, seenObjects = new WeakSet()) {
      if (!node || typeof node !== 'object' || depth > maxDepth) return;
      if (seenObjects.has(node)) return;
      seenObjects.add(node);

      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1, maxDepth, seenObjects);
        return;
      }

      const logo = logoFromObject(node);
      const name = nameFromObject(node);
      if (logo && (name || node.alt || node.title || node.caption)) {
        addCandidate({
          logo: safeValue(logo),
          name: safeValue(name),
          alt: safeValue(node.alt || node.title || ''),
          context: safeValue(node.caption || node.description || ''),
        });
      }

      for (const value of Object.values(node)) {
        walk(value, depth + 1, maxDepth, seenObjects);
      }
    }

    // 1) Known globals
    const roots = [
      window.__INITIAL_STATE__,
      window.environment,
      window.__NEXT_DATA__,
      window.__NUXT__,
      window.__DATA__,
    ];

    for (const root of roots) {
      try {
        walk(root);
      } catch (_) {}
    }

    // 2) Scripts con patrones comunes
    const scripts = [...document.querySelectorAll('script')].map(s => s.textContent || '');
    const regexes = [
      /"name"\s*:\s*"([^"]+)"[\s\S]{0,220}?"(?:image_path|small_image_path|logo|image|badge|icon|src)"\s*:\s*"([^"]+)"/g,
      /"(?:image_path|small_image_path|logo|image|badge|icon|src)"\s*:\s*"([^"]+)"[\s\S]{0,220}?"name"\s*:\s*"([^"]+)"/g,
      /'name'\s*:\s*'([^']+)'[\s\S]{0,220}?'(?:image_path|small_image_path|logo|image|badge|icon|src)'\s*:\s*'([^']+)'/g,
      /'(?:image_path|small_image_path|logo|image|badge|icon|src)'\s*:\s*'([^']+)'[\s\S]{0,220}?'name'\s*:\s*'([^']+)'/g,
    ];

    for (const content of scripts) {
      for (const regex of regexes) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(content))) {
          const a = match[1] || '';
          const b = match[2] || '';
          const firstLooksLikeUrl = /^https?:\/\//i.test(a);
          const secondLooksLikeUrl = /^https?:\/\//i.test(b);

          if (firstLooksLikeUrl) {
            addCandidate({ logo: a, name: secondLooksLikeUrl ? '' : b });
          } else if (secondLooksLikeUrl) {
            addCandidate({ logo: b, name: a });
          }
        }
      }
    }

    // 3) DOM: imágenes + contexto cercano
    const imgs = [...document.querySelectorAll('img[src]')];
    for (const img of imgs) {
      const src = img.currentSrc || img.src || '';
      if (!/^https?:\/\//i.test(src)) continue;

      const alt = img.alt || img.title || '';
      const container = img.closest('a, button, li, article, section, div') || img.parentElement;
      const context = getTextSnippet(container);

      // capturamos un subconjunto razonable de imágenes para no inflar demasiado
      if (
        /logo|badge|crest|shield|team|club|escudo|participant|home|away/i.test(src) ||
        /logo|badge|crest|shield|escudo/i.test(alt) ||
        context
      ) {
        addCandidate({ logo: src, name: alt, alt, context });
      }
    }

    // 4) Meta / enlaces con imagen destacada
    const metas = [
      ...document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]'),
    ];
    for (const meta of metas) {
      const content = meta.getAttribute('content') || '';
      if (/^https?:\/\//i.test(content)) {
        addCandidate({ logo: content, context: 'meta-image' });
      }
    }

    return candidates;
  });
}

async function searchFlashscoreMatchUrl(page, homeTeam, awayTeam) {
  const queries = buildMatchQueries(homeTeam, awayTeam);
  return findFlashscoreUrl(page, queries, homeTeam, awayTeam, 'match');
}

async function searchFlashscoreTeamUrl(page, teamName) {
  const queries = buildTeamQueries(teamName);
  return findFlashscoreUrl(page, queries, teamName, '', 'team');
}

async function resolveMatchLogos(page, homeTeam, awayTeam) {
  console.log(`  Buscando partido: ${homeTeam} vs ${awayTeam}`);

  const flashscoreUrl = await searchFlashscoreMatchUrl(page, homeTeam, awayTeam);

  if (!flashscoreUrl) {
    console.log('  [WARN] No se encontró URL del partido en Flashscore');
    return { homeLogo: null, awayLogo: null };
  }

  console.log(`  [OK] URL encontrada: ${flashscoreUrl}`);

  try {
    await page.goto(flashscoreUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
  } catch (error) {
    console.log(`  [ERROR] Navegando a Flashscore: ${error.message}`);
    return { homeLogo: null, awayLogo: null };
  }

  const candidates = await extractLogoCandidatesFromFlashscore(page);
  const homeLogo = pickBestCandidate(candidates, homeTeam);
  const awayLogo = pickBestCandidate(candidates, awayTeam, homeLogo);

  console.log(
    `  [MATCH] Local: ${homeLogo ? 'SI' : 'NO'}, Visitante: ${awayLogo ? 'SI' : 'NO'} (candidatos: ${candidates.length})`
  );

  return { homeLogo, awayLogo };
}

async function resolveTeamLogo(page, teamName) {
  const teamUrl = await searchFlashscoreTeamUrl(page, teamName);

  if (!teamUrl) {
    console.log(`  [TEAM WARN] No se encontró URL individual para ${teamName}`);
    return null;
  }

  console.log(`  [TEAM OK] URL individual: ${teamUrl}`);

  try {
    await page.goto(teamUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2200);
  } catch (error) {
    console.log(`  [TEAM ERROR] Navegando a equipo: ${error.message}`);
    return null;
  }

  const candidates = await extractLogoCandidatesFromFlashscore(page);
  const logo = pickBestCandidate(candidates, teamName);

  if (logo) {
    console.log(`  [TEAM MATCH] Escudo encontrado para ${teamName}`);
    return logo;
  }

  // último intento: elegir la primera imagen "razonable"
  const fallback = candidates.find(c => /^https?:\/\//i.test(c.logo))?.logo || null;
  if (fallback) {
    console.log(`  [TEAM FALLBACK] Escudo encontrado por fallback para ${teamName}`);
    return fallback;
  }

  console.log(`  [TEAM WARN] No se pudo extraer escudo para ${teamName}`);
  return null;
}

async function scrapeEscudos() {
  console.log('[Escudos] Iniciando scraping robusto...');

  if (!fs.existsSync(PARTIDOS_PATH)) {
    console.warn('[Escudos] No existe partidos.json');
    saveEmptyJson();
    return;
  }

  const partidos = JSON.parse(fs.readFileSync(PARTIDOS_PATH, 'utf-8'));

  if (!partidos?.length) {
    console.log('[Escudos] No hay partidos');
    saveEmptyJson();
    return;
  }

  console.log(`[Escudos] ${partidos.length} partidos encontrados`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    locale: 'es-ES',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.includes('consent.google.com')) route.abort();
    else route.continue();
  });

  await context.addCookies([
    {
      name: 'CONSENT',
      value: 'YES+ES.es+V14+BX',
      domain: '.google.com',
      path: '/',
    },
    {
      name: 'CONSENT',
      value: 'YES+ES.es+V14+BX',
      domain: '.google.es',
      path: '/',
    },
  ]);

  const logoCache = new Map();
  const escudos = [];
  const seenMatches = new Set();

  try {
    for (let i = 0; i < partidos.length; i++) {
      const partido = partidos[i];
      const matchText = partido.match;

      if (!matchText) continue;

      const [homeTeam, awayTeam] = extractTeamNames(matchText);
      if (!homeTeam || !awayTeam) {
        console.log(`[${i + 1}/${partidos.length}] Saltando: "${matchText}"`);
        continue;
      }

      const matchKey = `${homeTeam} vs ${awayTeam}`;
      const cacheHomeKey = normalizeTeamKey(homeTeam);
      const cacheAwayKey = normalizeTeamKey(awayTeam);

      if (seenMatches.has(matchKey)) continue;
      seenMatches.add(matchKey);

      console.log(`\n[${i + 1}/${partidos.length}] ${matchKey}`);

      let homeLogo = logoCache.get(cacheHomeKey) || null;
      let awayLogo = logoCache.get(cacheAwayKey) || null;

      if (!homeLogo || !awayLogo) {
        const matchResult = await resolveMatchLogos(page, homeTeam, awayTeam);

        if (!homeLogo && matchResult.homeLogo) {
          homeLogo = matchResult.homeLogo;
          logoCache.set(cacheHomeKey, homeLogo);
        }

        if (!awayLogo && matchResult.awayLogo) {
          awayLogo = matchResult.awayLogo;
          logoCache.set(cacheAwayKey, awayLogo);
        }
      }

      // Fallback individual SOLO para los que faltan
      if (!homeLogo) {
        const teamLogo = await resolveTeamLogo(page, homeTeam);
        if (teamLogo) {
          homeLogo = teamLogo;
          logoCache.set(cacheHomeKey, homeLogo);
        }
      }

      if (!awayLogo) {
        const teamLogo = await resolveTeamLogo(page, awayTeam);
        if (teamLogo) {
          awayLogo = teamLogo;
          logoCache.set(cacheAwayKey, awayLogo);
        }
      }

      // Si ambos quedaron idénticos, intentamos corregir el visitante con su fallback individual
      if (homeLogo && awayLogo && homeLogo === awayLogo) {
        const altAway = await resolveTeamLogo(page, awayTeam);
        if (altAway && altAway !== homeLogo) {
          awayLogo = altAway;
          logoCache.set(cacheAwayKey, awayLogo);
        }
      }

      if (homeLogo || awayLogo) {
        escudos.push({
          match: matchKey,
          homeLogo: homeLogo || '',
          awayLogo: awayLogo || '',
        });
      } else {
        console.log('  [WARN] No se encontró ningún escudo');
      }

      if (i < partidos.length - 1) {
        await sleep(1400 + Math.random() * 1200);
      }
    }

    ensureDir(OUTPUT);
    fs.writeFileSync(OUTPUT, JSON.stringify(escudos, null, 2), 'utf-8');

    console.log(`\n[Escudos] ${escudos.length} partidos guardados`);

    const totalTeams = new Set();
    for (const p of partidos) {
      const [h, a] = extractTeamNames(p.match);
      if (h) totalTeams.add(normalizeTeamKey(h));
      if (a) totalTeams.add(normalizeTeamKey(a));
    }

    const foundTeams = [...logoCache.values()].filter(Boolean).length;
    console.log(`[Escudos] Equipos únicos: ${totalTeams.size}, Escudos cacheados: ${foundTeams}`);
  } catch (error) {
    console.warn('[Escudos] Error:', error.message);
    saveEmptyJson();
    process.exitCode = 0;
  } finally {
    await browser.close();
  }
}

scrapeEscudos().catch(error => {
  console.warn('[Escudos] Error inesperado:', error.message);
  saveEmptyJson();
  process.exitCode = 0;
});
