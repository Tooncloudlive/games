# Integracion Streams HLS - Instrucciones

## Resumen de Cambios

Se integro un sistema de extraccion automatica de streams HLS (.m3u8) sobre la arquitectura existente sin modificar la logica de escudos, el diseno visual ni el pipeline de scraping de partidos.

### Archivos Nuevos
- `scripts/extract-m3u8.js` - Extractor de streams HLS con Playwright
- `data/streams.json` - Archivo de salida con los streams m3u8 validos

### Archivos Modificados
- `template.html` - Agregado HLS.js CDN, reproductor `<video>`, funciones de control
- `scripts/build.js` - Agregada carga e inyeccion de `streamsData`
- `package.json` - Agregado script `extract:m3u8`
- `.github/workflows/scrape.yml` - Agregado paso de extraccion m3u8, cache, frecuencia 2x dia

### Archivos Sin Modificar (funcionan igual)
- `scripts/scrape-partidos.js`
- `scripts/scrape-escudos.js`
- `data/partidos.json`
- `data/escudos.json`
- `index.html` (se regenera via build)

## Arquitectura Final

```
.github/workflows/scrape.yml   # CI: 2 veces al dia
scripts/
  scrape-partidos.js            # Scrapea streamx550.com -> data/partidos.json (EXISTENTE)
  scrape-escudos.js             # Scrapea Flashscore -> data/escudos.json (EXISTENTE)
  extract-m3u8.js               # NUEVO: Abre cada link, extrae .m3u8 -> data/streams.json
  build.js                      # MODIFICADO: Inyecta los 3 JSON en template.html -> index.html
data/
  partidos.json                 # Generado por scrape-partidos.js
  escudos.json                  # Generado por scrape-escudos.js
  streams.json                  # NUEVO: Generado por extract-m3u8.js
template.html                   # MODIFICADO: Template con HLS.js y reproductor video
index.html                      # Salida generada (frontend final en 1 solo archivo)
package.json                    # MODIFICADO: Script extract:m3u8 agregado
```

## Flujo de Datos

1. **scrape-partidos.js** genera `data/partidos.json` con links base (ej: `https://streamx550.com/global2.php?channel=dsports`)
2. **scrape-escudos.js** lee `partidos.json` y genera `data/escudos.json` con logos de Flashscore
3. **extract-m3u8.js** (NUEVO) lee `partidos.json`, abre cada link con Playwright, intercepta requests de red, detecta `.m3u8`, valida con HEAD request, genera `data/streams.json`
4. **build.js** lee los 3 JSON y genera `index.html` inyectando los datos

## Formato de Salida de Streams

```json
[
  {
    "channel": "dsports",
    "source": "https://streamx550.com/global2.php?channel=dsports",
    "stream": "https://cdn.example.com/live/dsports.m3u8"
  }
]
```

## Instalacion

```bash
# 1. Clonar el repositorio
git clone https://github.com/Tooncloudlive/Deportes-cloud.git
cd Deportes-cloud

# 2. Instalar dependencias
npm install

# 3. Instalar Playwright Chromium
npx playwright install chromium
```

## Ejecucion Manual

```bash
# Ejecutar todo el pipeline
npm run scrape:all

# O paso por paso:
npm run scrape:partidos    # Extrae partidos de streamx550
npm run scrape:escudos     # Extrae escudos de Flashscore
npm run extract:m3u8       # Extrae streams HLS de los links
npm run build              # Genera index.html
```

## Validacion de Extraccion de Streams

```bash
# Verificar que streams.json se genero
cat data/streams.json

# Ver cantidad de streams encontrados
node -e "const s=require('./data/streams.json'); console.log(s.length, 'streams encontrados'); s.forEach(x=>console.log('-', x.channel, '->', x.stream.substring(0,60)+'...'))"
```

## Configuracion de GitHub Actions

El workflow se ejecuta automaticamente **2 veces al dia** (06:00 UTC y 18:00 UTC).

Para ejecutar manualmente:
1. Ir a la pestana **Actions** en GitHub
2. Seleccionar el workflow **Scraping Automatico de Partidos, Escudos y Streams HLS**
3. Click en **Run workflow**

### Optimizaciones de Consumo
- Cache de Playwright browsers para evitar reinstalacion
- Solo se hace commit si hay cambios reales (`git diff --cached --quiet`)
- Concurrency: cancela ejecuciones en progreso si hay una nueva
- Frecuencia conservadora: 2 veces al dia (no cada minuto)

## Notas Tecnincas

### Sobre el Reproductor HLS.js
- Si el navegador soporta HLS.js (Chrome, Firefox, Edge), se usa la libreria con configuracion optimizada para live streaming
- Si es Safari, usa el reproductor nativo (Safari soporta HLS nativamente)
- Si no se encuentra un m3u8 para un canal, hace fallback al link original (abre en nueva pestana)

### Tolerancia a Fallos
- Un canal que falle no bloquea los demas
- Maximo 2 reintentos por canal
- Si `extract-m3u8.js` falla completamente, preserva el `streams.json` anterior
- El pipeline de GitHub Actions nunca se rompe por un script individual

### Seguridad
- Los streams se extraen desde las fuentes originales (streamx550.com)
- El sitio sigue sin alojar contenido propio
- El reproductor es un `<video>` HTML5 estandar con HLS.js
