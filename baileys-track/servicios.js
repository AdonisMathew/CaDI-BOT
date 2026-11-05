// CaDI - Servicios externos que el bridge usa para actuar en WhatsApp:
//   - generarImagen(): crea una imagen con IA (Cloudflare Workers AI o Pollinations)
//   - buscarLugar():   busca un lugar en el mapa (OpenStreetMap / Nominatim) con prioridad en Tucumán
//
// Se llaman desde el bridge (y no desde n8n) para que la imagen o el mapa nunca pasen
// por el modelo: una imagen en base64 son miles de tokens que Groq no tiene por qué ver.

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// 1. Imágenes
// =====================================================================

const IMAGEN_PROVEEDOR = (process.env.IMAGEN_PROVEEDOR || 'cloudflare').toLowerCase();

// Cloudflare Workers AI: 10.000 "neuronas" gratis por día. FLUX.1 [schnell] a 1024x1024 con
// 4 pasos gasta ~58, o sea ~170 imágenes diarias sin pagar nada.
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_API_TOKEN = process.env.CF_API_TOKEN || '';
const CF_MODELO = process.env.CF_MODELO_IMAGEN || '@cf/black-forest-labs/flux-1-schnell';

// Pollinations: ahora pide una clave secreta (sk_...) de enter.pollinations.ai
const POLLINATIONS_KEY = process.env.POLLINATIONS_KEY || '';
const POLLINATIONS_MODELO = process.env.POLLINATIONS_MODELO || 'flux';

/** ¿Hay un proveedor de imágenes configurado? Devuelve null si sí, o el motivo si no. */
export function imagenesNoConfiguradas() {
  if (IMAGEN_PROVEEDOR === 'cloudflare' && (!CF_ACCOUNT_ID || !CF_API_TOKEN)) {
    return 'faltan CF_ACCOUNT_ID y CF_API_TOKEN en el .env del bridge';
  }
  if (IMAGEN_PROVEEDOR === 'pollinations' && !POLLINATIONS_KEY) {
    return 'falta POLLINATIONS_KEY en el .env del bridge';
  }
  if (!['cloudflare', 'pollinations'].includes(IMAGEN_PROVEEDOR)) {
    return `IMAGEN_PROVEEDOR="${IMAGEN_PROVEEDOR}" no existe (usá cloudflare o pollinations)`;
  }
  return null;
}

async function imagenCloudflare(prompt) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_MODELO}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, steps: 4 }),
    signal: AbortSignal.timeout(90000),
  });
  const tipo = r.headers.get('content-type') || '';
  // Algunos modelos devuelven la imagen directa; FLUX devuelve JSON con la imagen en base64
  if (r.ok && tipo.startsWith('image/')) return Buffer.from(await r.arrayBuffer());
  const datos = await r.json().catch(() => ({}));
  if (!r.ok || datos.success === false) {
    const motivo = datos.errors?.[0]?.message || `HTTP ${r.status}`;
    if (r.status === 429 || /quota|neurons|limit/i.test(motivo)) {
      throw new Error('se terminó la cuota gratis de imágenes de hoy (se renueva a las 21:00 de Tucumán)');
    }
    if (r.status === 401 || r.status === 403) throw new Error('Cloudflare rechazó el token (revisá CF_API_TOKEN y CF_ACCOUNT_ID)');
    throw new Error(`Cloudflare respondió: ${motivo}`);
  }
  const base64 = datos.result?.image;
  if (!base64) throw new Error('Cloudflare no devolvió ninguna imagen');
  return Buffer.from(base64, 'base64');
}

async function imagenPollinations(prompt) {
  const params = new URLSearchParams({
    model: POLLINATIONS_MODELO,
    width: '1024',
    height: '1024',
    seed: String(Math.floor(Math.random() * 1e9)),
  });
  const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?${params}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${POLLINATIONS_KEY}` },
    signal: AbortSignal.timeout(120000),
  });
  const tipo = r.headers.get('content-type') || '';
  if (!r.ok || !tipo.startsWith('image/')) {
    if (r.status === 401 || r.status === 403) throw new Error('Pollinations rechazó la clave (revisá POLLINATIONS_KEY)');
    if (r.status === 402 || r.status === 429) throw new Error('Pollinations no tiene saldo o pidió esperar; probá más tarde');
    throw new Error(`Pollinations respondió HTTP ${r.status}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Genera una imagen y devuelve sus bytes (JPEG/PNG).
 * @param {string} prompt descripción, idealmente en inglés
 */
export async function generarImagen(prompt) {
  const falta = imagenesNoConfiguradas();
  if (falta) throw new Error(`la creación de imágenes no está configurada: ${falta}`);
  const buffer = IMAGEN_PROVEEDOR === 'pollinations' ? await imagenPollinations(prompt) : await imagenCloudflare(prompt);
  if (buffer.length < 1000) throw new Error('la imagen generada llegó vacía o rota');
  return buffer;
}

// =====================================================================
// 2. Lugares (OpenStreetMap / Nominatim)
// =====================================================================

// Nominatim es gratis y sin clave, con dos condiciones: como máximo 1 pedido por segundo y
// un User-Agent que identifique a la app. https://operations.osmfoundation.org/policies/nominatim/
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || '';
const USER_AGENT = 'CaDI-WhatsApp-Bot/1.1 (+https://github.com/AdonisMathew/CaDI-BOT)';

// Provincia de Tucumán (oeste, norte, este, sur): primero se busca acá adentro
const CAJA_TUCUMAN = process.env.UBICACION_CAJA || '-66.25,-26.05,-64.45,-28.05';

let ultimoPedidoNominatim = 0;
async function pedirNominatim(params) {
  // Respeta el máximo de 1 pedido por segundo aunque lleguen varios juntos
  const espera = ultimoPedidoNominatim + 1100 - Date.now();
  ultimoPedidoNominatim = Math.max(Date.now(), ultimoPedidoNominatim + 1100);
  if (espera > 0) await esperar(espera);

  const q = new URLSearchParams({ format: 'jsonv2', limit: '1', 'accept-language': 'es', ...params });
  if (NOMINATIM_EMAIL) q.set('email', NOMINATIM_EMAIL);
  const r = await fetch(`${NOMINATIM_URL}?${q}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`el servicio de mapas respondió HTTP ${r.status}`);
  const lista = await r.json();
  return Array.isArray(lista) && lista.length ? lista[0] : null;
}

/**
 * Busca un lugar. Primero dentro de la provincia de Tucumán y, si no aparece, en todo el mundo.
 * @returns {Promise<{lat:number, lon:number, nombre:string, direccion:string} | null>}
 */
export async function buscarLugar(consulta) {
  const texto = String(consulta ?? '').trim();
  if (texto.length < 2) return null;
  const hallado =
    (await pedirNominatim({ q: texto, viewbox: CAJA_TUCUMAN, bounded: '1' })) ||
    (await pedirNominatim({ q: texto }));
  if (!hallado) return null;
  const partes = String(hallado.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
  const nombre = hallado.name || partes[0] || texto;
  return {
    lat: Number(hallado.lat),
    lon: Number(hallado.lon),
    nombre,
    // Sin repetir el nombre ni el país, y no tan larga (WhatsApp la muestra debajo del pin)
    direccion: partes.filter((p) => p !== nombre && p !== 'Argentina').slice(0, 4).join(', '),
  };
}
