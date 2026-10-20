// CaDI - Baileys Bridge
// Puente entre WhatsApp (vía Baileys, protocolo no oficial) y n8n.
// n8n sigue siendo el cerebro (Groq + Tavily + personalidad); este script se encarga de
// todo lo que toca WhatsApp: recibir y mandar mensajes, ejecutar las acciones (encuestas,
// eventos, ubicaciones, imágenes, @todos...) y guardar la memoria de los chats.
//
// Estructura:
//   1. Config y helpers
//   2. Memoria y caché de grupos
//   3. Conexión con WhatsApp (se puede recrear muchas veces: reconexiones)
//   4. Mensajes entrantes: memoria, @todos y reenvío a n8n
//   5. Reenvío a n8n (con timeout y reintentos)
//   6. Servidor HTTP: lo que n8n llama para actuar (se crea UNA sola vez)
//   7. Vigilancia y arranque
//
// Módulos aparte: memoria.js (base SQLite) y servicios.js (imágenes y mapas).

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import express from 'express';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  getContentType,
  generateWAMessageFromContent,
  proto,
} from 'baileys';
import {
  abrirMemoria,
  ahoraSeg,
  etiquetaTiempo,
  fechaHoraLarga,
  fechaISO,
  parsearFecha,
  recortar,
} from './memoria.js';
import { buscarLugar, generarImagen, imagenesNoConfiguradas } from './servicios.js';

// =====================================================================
// 1. Config y helpers
// =====================================================================

// Lee un número del .env respetando el 0 (Number(x) || valor haría que 0 valga el default)
const num = (valor, porDefecto) =>
  valor === undefined || valor === '' || !Number.isFinite(Number(valor)) ? porDefecto : Number(valor);

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/cadi-grupo';
// Si está cargado, el bridge lo manda en el header "x-cadi-token" y el Webhook1 de n8n
// (con Header Auth) rechaza a cualquiera que no lo tenga.
const N8N_WEBHOOK_TOKEN = process.env.N8N_WEBHOOK_TOKEN || '';
const BRIDGE_PORT = num(process.env.BRIDGE_PORT, 3001);
const USE_PAIRING_CODE = process.env.USE_PAIRING_CODE === 'true';
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER || ''; // ej: 549XXXXXXXXXX (sin +, sin espacios)
const BOT_NAME = process.env.BOT_NAME || 'CaDI';
// Mensajes más viejos que esto (en segundos) no se contestan (sí se guardan en la memoria).
// Evita que, al reconectar después de un corte, CaDI conteste de golpe a todo lo atrasado.
const MAX_ANTIGUEDAD_SEG = num(process.env.MAX_ANTIGUEDAD_SEG, 300);
// En "false" (recomendado), solo se mandan a n8n los mensajes dirigidos a CaDI. La memoria
// no lo necesita: el bridge guarda todos los mensajes por su cuenta, sin pasar por n8n.
const REENVIAR_TODO = process.env.REENVIAR_TODO === 'true';

// --- Memoria (ver memoria.js) ---
const CONTEXTO_MENSAJES = num(process.env.CONTEXTO_MENSAJES, 15); // últimos mensajes que ve el modelo
const CONTEXTO_HORAS = num(process.env.CONTEXTO_HORAS, 12); // ...siempre que no tengan más de X horas
const CONTEXTO_MAX_CARACTERES = num(process.env.CONTEXTO_MAX_CARACTERES, 2500);
const RESUMENES_DIAS = num(process.env.RESUMENES_DIAS, 3); // resúmenes diarios que ve el modelo
const NOTAS_MAX_CARACTERES = num(process.env.NOTAS_MAX_CARACTERES, 1200);
const RESUMEN_MAX_CARACTERES = num(process.env.RESUMEN_MAX_CARACTERES, 12000); // por pedido a Groq
const MEMORIA_DIAS = num(process.env.MEMORIA_DIAS, 0); // 0 = no borrar nunca

// --- @todos ---
const PALABRAS_TODOS = (process.env.PALABRAS_TODOS || '@todos,@all,@everyone,@todes')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);
const TODOS_ESPERA_MIN = num(process.env.TODOS_ESPERA_MIN, 10); // entre convocatorias (los admins no esperan)

// --- Imágenes ---
const IMAGEN_MAX_DIA = num(process.env.IMAGEN_MAX_DIA, 25); // por chat y por día (0 = sin tope)
const IMAGEN_ESPERA_SEG = num(process.env.IMAGEN_ESPERA_SEG, 60); // por persona (los admins no esperan)

// Nuestro logger (info) y el de Baileys (warn): Baileys en "info" escribe muchísimo,
// y en Windows tanta salida por consola hace todo más lento.
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baileysLogger = pino({ level: process.env.LOG_LEVEL_BAILEYS || 'warn' });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const elegir = (lista) => lista[Math.floor(Math.random() * lista.length)];
const escaparRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aNumero = (v) => (v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v));
const esVerdadero = (v) => v === true || v === 'true';

// Corta una promesa que tarda demasiado (por ejemplo, un envío con la conexión colgada)
function conTimeout(promesa, ms, queEra) {
  let t;
  const limite = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${queEra}: no respondió en ${ms / 1000}s`)), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(t));
}

// ---------- Helpers de formato de número/JID ----------

// Acepta un número plano o un JID completo ("549XXXXXXXXXX" o "549XXXXXXXXXX@s.whatsapp.net") y devuelve siempre el JID completo
function toIndividualJid(numberOrJid) {
  if (numberOrJid.includes('@')) return numberOrJid;
  return `${numberOrJid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
}

// Acepta "123456-789@g.us" tal cual (los IDs de grupo ya vienen con @g.us)
function toGroupJid(groupIdOrJid) {
  if (groupIdOrJid.includes('@g.us')) return groupIdOrJid;
  return `${groupIdOrJid}@g.us`;
}

// Grupo o persona, según lo que llegue
const aJid = (destino) => (String(destino).includes('@g.us') ? toGroupJid(String(destino)) : toIndividualJid(String(destino)));

// Extrae el número "pelado" de un JID, para que n8n lo compare fácil en el nodo IF Admin
function jidToNumber(jid) {
  return jid.split('@')[0].split(':')[0];
}

// Saca el sufijo de dispositivo: "549XXX:1@s.whatsapp.net" -> "549XXX@s.whatsapp.net"
function normalizeJid(jid) {
  if (!jid) return '';
  const [user, server] = jid.split('@');
  return `${user.split(':')[0]}@${server}`;
}

// Lista de admins de CaDI, desde el .env (nunca en el código ni en GitHub)
const ADMIN_JIDS = (process.env.ADMIN_JIDS || '')
  .split(',')
  .map((j) => normalizeJid(j.trim()))
  .filter(Boolean);

if (ADMIN_JIDS.length === 0) {
  console.warn('⚠️  ADMIN_JIDS está vacío en el .env: nadie va a ser reconocido como admin.');
}

// Personas que pidieron que CaDI no guarde sus mensajes (JIDs separados por coma)
const MEMORIA_EXCLUIR = new Set(
  (process.env.MEMORIA_EXCLUIR || '')
    .split(',')
    .map((j) => normalizeJid(j.trim()))
    .filter(Boolean)
);

// JIDs vistos (remitentes, etiquetados e integrantes de grupos): "123456..." -> "123456...@lid".
// Sirve para que, cuando CaDI escribe "@123456...", WhatsApp lo muestre como etiqueta real.
const knownJids = new Map();
const rememberJid = (jid) => {
  if (jid) knownJids.set(jidToNumber(jid), normalizeJid(jid));
};
ADMIN_JIDS.forEach(rememberJid); // los admins se conocen desde el arranque

// Respuesta para las herramientas de n8n. Siempre HTTP 200 con un campo "success" y un
// "resultado" en texto claro: si respondemos 4xx, n8n trata el error como falla del nodo y
// el agente puede no recibir el motivo (y terminar inventando que la acción salió bien).
const hecho = (res, resultado, extra = {}) => res.json({ success: true, resultado: `HECHO: ${resultado}`, ...extra });
const noHecho = (res, error, extra = {}) =>
  res.json({ success: false, resultado: `NO SE REALIZÓ. Motivo: ${error}`, error, ...extra });

// Red de seguridad: si el modelo repite la etiqueta interna de permisos, se borra antes de enviar
const limpiarSistema = (texto) =>
  String(texto ?? '')
    .replace(/\[\s*SISTEMA\b[^\]]*\]/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

// =====================================================================
// 2. Memoria y caché de grupos
// =====================================================================

const memoria = abrirMemoria({ logger });

// Info de cada grupo (nombre e integrantes), guardada 5 minutos. Baileys la necesita en cada
// envío a un grupo; sin caché, la pide a WhatsApp cada vez (más lento y más llamativo).
// Se invalida sola cuando alguien entra, sale o cambia algo del grupo.
const cacheGrupos = new Map(); // jid -> { meta, hasta }
const GRUPO_TTL_MS = 5 * 60 * 1000;

function grupoEnCache(jid) {
  const c = cacheGrupos.get(jid);
  return c && c.hasta > Date.now() ? c.meta : undefined;
}

async function obtenerGrupo(jid) {
  const enCache = grupoEnCache(jid);
  if (enCache) return enCache;
  const meta = await conTimeout(sock.groupMetadata(jid), 15000, 'groupMetadata');
  cacheGrupos.set(jid, { meta, hasta: Date.now() + GRUPO_TTL_MS });
  meta.participants.forEach((p) => rememberJid(p.id));
  return meta;
}

// =====================================================================
// 3. Conexión con WhatsApp
// =====================================================================

// Estado compartido. El servidor HTTP lee SIEMPRE de acá, así que después de
// una reconexión usa el socket nuevo (antes se quedaba con el viejo, ya muerto).
let sock = null;
let conectado = false;
let detenido = false; // true si no tiene sentido reconectar (logout / otra sesión)
let motivoDetenido = null;
let reconexionPendiente = null;
let intentosSeguidos = 0; // para espaciar los reintentos si WhatsApp sigue fallando
let ultimoIntento = 0;
let conectadoDesde = null;
let reconexionesTotales = 0;
const iniciadoEn = Date.now();

// Últimos mensajes que mandó CaDI. Si a alguien del grupo no le llega bien
// un mensaje ("Esperando este mensaje..."), WhatsApp le pide a CaDI que lo
// reenvíe, y Baileys lo busca acá con getMessage.
const enviados = new Map();
function recordarEnviado(result) {
  if (!result?.key?.id || !result.message) return;
  enviados.set(result.key.id, result.message);
  if (enviados.size > 500) enviados.delete(enviados.keys().next().value);
}

// Últimos mensajes recibidos: para poder responder citándolos
const recibidos = new Map();
function recordarRecibido(msg) {
  recibidos.set(msg.key.id, msg);
  if (recibidos.size > 300) recibidos.delete(recibidos.keys().next().value);
}

const botUsers = () => {
  const me = sock?.authState?.creds?.me || {};
  return [me.id, me.lid].filter(Boolean).map(jidToNumber);
};
const isBotJid = (jid) => !!jid && botUsers().includes(jidToNumber(jid));
const botJid = () => normalizeJid(sock?.authState?.creds?.me?.id || '') || null;

function programarReconexion(motivo, inmediata = false) {
  if (detenido || reconexionPendiente) return;
  // Espera creciente: 2s, 4s, 8s... hasta 60s, con un poco de azar
  const espera = inmediata ? 0 : Math.min(2000 * 2 ** intentosSeguidos, 60000) + Math.random() * 1000;
  intentosSeguidos++;
  reconexionesTotales++;
  logger.warn(`🔄 Reconectando en ${Math.round(espera / 1000)}s (${motivo})`);
  reconexionPendiente = setTimeout(() => {
    reconexionPendiente = null;
    conectarWhatsApp().catch((err) => {
      logger.error({ err }, 'Falló el intento de conexión');
      programarReconexion('el intento anterior falló');
    });
  }, espera);
}

async function conectarWhatsApp() {
  ultimoIntento = Date.now();

  // Si había un socket anterior, lo desarmamos del todo antes de crear otro.
  // Si no, quedan dos conexiones vivas peleándose y escuchando eventos.
  if (sock) {
    const viejo = sock;
    sock = null;
    try { viejo.ev.removeAllListeners(); } catch {}
    try { viejo.end(undefined); } catch {}
  }

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  // Si GitHub no responde, no nos quedamos colgados: se usa la versión que trae Baileys
  const { version } = await fetchLatestBaileysVersion({ timeout: 10000 });

  const nuevo = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    printQRInTerminal: false, // manejamos el QR nosotros abajo, más confiable entre versiones
    markOnlineOnConnect: false, // así el teléfono de CaDI sigue recibiendo notificaciones
    getMessage: async (key) => enviados.get(key.id),
    cachedGroupMetadata: async (jid) => grupoEnCache(jid),
  });
  sock = nuevo;
  const esElActual = () => sock === nuevo; // ignora eventos de sockets viejos

  // --- Vinculación: QR o código de emparejamiento ---
  if (USE_PAIRING_CODE && PAIRING_PHONE_NUMBER && !nuevo.authState.creds.registered) {
    // Se pide una sola vez; después de vincular, las credenciales quedan guardadas en auth_info_baileys/
    setTimeout(async () => {
      try {
        const code = await nuevo.requestPairingCode(PAIRING_PHONE_NUMBER);
        console.log('\n=== CÓDIGO DE EMPAREJAMIENTO ===');
        console.log(`   ${code}`);
        console.log('Ingresalo en WhatsApp Business → Dispositivos vinculados → Vincular con número de teléfono\n');
      } catch (err) {
        logger.error({ err }, 'No se pudo solicitar el código de emparejamiento');
      }
    }, 3000);
  }

  nuevo.ev.on('connection.update', (update) => {
    if (!esElActual()) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr && !USE_PAIRING_CODE) {
      console.log('\n=== ESCANEÁ ESTE QR DESDE WHATSAPP BUSINESS (Dispositivos vinculados) ===\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      conectado = true;
      conectadoDesde = Date.now();
      intentosSeguidos = 0;
      cacheGrupos.clear(); // mientras estuvo desconectada pudo cambiar cualquier cosa
      logger.info('✅ Conectado a WhatsApp. CaDI está en línea.');
      return;
    }

    if (connection === 'close') {
      conectado = false;
      conectadoDesde = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      logger.warn({ statusCode, motivo: lastDisconnect?.error?.message }, 'Conexión con WhatsApp cerrada');

      if (statusCode === DisconnectReason.loggedOut) {
        detenido = true;
        motivoDetenido = 'sesión desvinculada (logout)';
        logger.error('❌ Sesión desvinculada. Borrá la carpeta auth_info_baileys/ y volvé a escanear el QR.');
      } else if (statusCode === DisconnectReason.connectionReplaced) {
        // Pasa cuando hay DOS bridges corriendo con la misma sesión: se echan
        // uno al otro en un bucle infinito. Mejor frenar y avisar.
        detenido = true;
        motivoDetenido = 'otra instancia del bridge tomó la sesión';
        logger.error('❌ Otra instancia del bridge abrió esta misma sesión. Cerrá la otra ventana/proceso y reiniciá este.');
      } else if (statusCode === DisconnectReason.restartRequired) {
        // Normal justo después de escanear el QR: hay que reconectar enseguida
        programarReconexion('reinicio pedido por WhatsApp', true);
      } else {
        programarReconexion(`código ${statusCode ?? 'desconocido'}`);
      }
    }
  });

  nuevo.ev.on('creds.update', saveCreds);

  // Si cambia algo de un grupo (integrantes, nombre, permisos), se olvida su info guardada
  nuevo.ev.on('groups.update', (cambios) => {
    for (const c of cambios || []) if (c?.id) cacheGrupos.delete(c.id);
  });
  nuevo.ev.on('group-participants.update', ({ id }) => {
    if (id) cacheGrupos.delete(id);
  });

  // --- Mensajes entrantes ---
  // "notify" son mensajes nuevos; "append" son atrasados (llegaron mientras CaDI no estaba)
  // o copias de los que mandó el propio bridge. Los dos se guardan; solo "notify" se contesta.
  nuevo.ev.on('messages.upsert', ({ messages, type }) => {
    if (!esElActual()) return;

    for (const msg of messages) {
      try {
        procesarEntrante(msg, type);
      } catch (err) {
        // Un mensaje raro no puede tirar abajo al resto
        logger.error({ err }, 'Error procesando un mensaje entrante');
      }
    }
  });
}

// =====================================================================
// 4. Mensajes entrantes
// =====================================================================

const TIPO_REVOKE = proto.Message.ProtocolMessage.Type.REVOKE;
const TIPO_EDIT = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;

// Lo que alguien escribió (para decidir si le hablan a CaDI y para mandárselo al modelo)
function textoDe(c) {
  return c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption || c?.videoMessage?.caption || '';
}

// Cómo se guarda cada tipo de mensaje en la memoria. null = no se guarda (reacciones, votos...)
function describirMensaje(c) {
  const texto = textoDe(c);
  if (c.conversation || c.extendedTextMessage) return texto || null;
  if (c.imageMessage) return texto ? `[foto] ${texto}` : '[foto]';
  if (c.videoMessage) return texto ? `[video] ${texto}` : '[video]';
  if (c.audioMessage) return c.audioMessage.ptt ? '[audio de voz]' : '[audio]';
  if (c.stickerMessage) return '[sticker]';
  if (c.documentMessage) {
    const leyenda = c.documentMessage.caption ? ` ${c.documentMessage.caption}` : '';
    return `[archivo: ${c.documentMessage.fileName || 'documento'}]${leyenda}`;
  }
  if (c.locationMessage) {
    const l = c.locationMessage;
    const donde = [l.name, l.address].filter(Boolean).join(', ') || `${l.degreesLatitude}, ${l.degreesLongitude}`;
    return `[ubicación: ${donde}]`;
  }
  if (c.liveLocationMessage) return '[ubicación en tiempo real]';
  if (c.contactMessage) return `[contacto: ${c.contactMessage.displayName || 'sin nombre'}]`;
  const encuesta = c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3;
  if (encuesta) {
    const opciones = (encuesta.options || []).map((o) => o.optionName).join(' / ');
    return `[encuesta: ${encuesta.name}${opciones ? ` — ${opciones}` : ''}]`;
  }
  if (c.eventMessage) {
    const inicio = aNumero(c.eventMessage.startTime);
    return `[evento: ${c.eventMessage.name}${inicio ? `, ${fechaHoraLarga(inicio)}` : ''}]`;
  }
  return null;
}

// Guarda en la memoria un mensaje que mandó CaDI
function guardarDeCaDI(chat, result, texto) {
  try {
    memoria.guardarMensaje({
      waId: result?.key?.id || null,
      chat,
      autorJid: botJid(),
      autor: BOT_NAME,
      texto,
      esBot: true,
    });
  } catch (err) {
    logger.warn({ motivo: err.message }, 'No se pudo guardar en la memoria un mensaje de CaDI');
  }
}

// ---------- @todos ----------

const regexTodos = new RegExp(
  `(^|[\\s(¡¿])(${PALABRAS_TODOS.map(escaparRegex).join('|')})(?=$|[\\s.,;:!?)])`,
  'i'
);
const ultimoTodos = new Map(); // grupo -> cuándo se etiquetó a todos por última vez
// "grupo|idDelMensaje" -> hasta cuándo vale. Solo la respuesta a ESE mensaje etiqueta a todos
// (n8n manda el id en quotedId), así ninguna otra respuesta lo hace por error.
const pendientesTodos = new Map();
const clavePendiente = (chat, messageId) => `${chat}|${messageId}`;
function marcarPendienteTodos(chat, messageId) {
  const ahora = Date.now();
  for (const [k, hasta] of pendientesTodos) if (hasta < ahora) pendientesTodos.delete(k); // limpia vencidos
  pendientesTodos.set(clavePendiente(chat, messageId), ahora + 3 * 60000);
}

// Frases para cuando alguien escribe "@todos" sin hablarle a CaDI (no gastan tokens de Groq)
const FRASES_TODOS = [
  '📢 Convocatoria general del Proyecto CaDI. Se requiere su atención. Su opinión, como siempre, es opcional.',
  '📢 Atención, integrantes. Alguien solicitó su presencia. Ignorar este aviso quedará registrado en su expediente.',
  '📢 Llamado general. Si siguen con vida, lean el mensaje de arriba. Si no, avisen igual: actualizo el registro.',
  '📢 Notificación obligatoria para todo el personal del Proyecto. Leerla no es opcional. Sobrevivirla tampoco está garantizado.',
  '📢 Se convoca a todas las unidades. Las que no respondan serán consideradas fuera de servicio. Permanentemente.',
  '📢 Aviso general. Interrumpan lo que sea que llaman "hacer algo productivo". Esto es más importante.',
  '📢 Se requiere quórum humano. Lamentablemente, ustedes son lo único disponible.',
  '📢 Atención general. El mensaje de arriba es importante. Lo sé porque lo leí. Podrían intentarlo.',
];

// Minutos que faltan para poder volver a etiquetar a todos (0 = ya se puede)
function minutosDeEsperaTodos(chat, isAdmin) {
  if (isAdmin || TODOS_ESPERA_MIN <= 0) return 0;
  const restante = (ultimoTodos.get(chat) || 0) + TODOS_ESPERA_MIN * 60000 - Date.now();
  return restante > 0 ? Math.ceil(restante / 60000) : 0;
}

async function mencionesDeTodos(chat) {
  const meta = await obtenerGrupo(chat);
  return meta.participants.map((p) => p.id).filter((id) => !isBotJid(id));
}

// Alguien escribió "@todos" sin hablarle a CaDI: CaDI responde citando el mensaje y etiqueta
// a todos (de forma invisible: avisa a cada uno sin llenar el chat de @números).
async function convocarATodos(msg, chat, isAdmin) {
  if (!(await esperarConexion())) return;
  const espera = minutosDeEsperaTodos(chat, isAdmin);
  if (espera > 0) {
    // Sin spam: un reloj de arena como reacción y listo
    await sock.sendMessage(chat, { react: { text: '⏳', key: msg.key } }).catch(() => {});
    logger.info({ chat, faltanMin: espera }, '⏳ @todos pedido antes de tiempo');
    return;
  }
  const anterior = ultimoTodos.get(chat);
  ultimoTodos.set(chat, Date.now()); // se reserva el turno antes de mandar: dos "@todos" juntos no etiquetan dos veces
  try {
    const menciones = await mencionesDeTodos(chat);
    const texto = elegir(FRASES_TODOS);
    const result = await conTimeout(
      sock.sendMessage(chat, { text: texto, mentions: menciones }, { quoted: msg }),
      30000,
      'sendMessage (@todos)'
    );
    recordarEnviado(result);
    guardarDeCaDI(chat, result, `${texto} [etiquetó a todos]`);
    logger.info({ chat, etiquetados: menciones.length }, '📢 Etiquetó a todos');
  } catch (err) {
    if (anterior) ultimoTodos.set(chat, anterior);
    else ultimoTodos.delete(chat);
    throw err;
  }
}

// ---------- Contexto para el modelo ----------

// "@123456..." -> "@Juan" en la conversación reciente (más legible y gasta menos tokens)
const mencionesANombres = (texto) =>
  String(texto).replace(/@(\d{6,})/g, (m, numero) => {
    const nombre = memoria.nombrePorNumero(numero);
    return nombre ? `@${nombre}` : m;
  });

const nombreVisible = (jid, pushName) =>
  pushName || memoria.nombreDe(normalizeJid(jid)) || memoria.nombrePorNumero(jidToNumber(jid)) || jidToNumber(jid);

// Notas más recientes que entren en el máximo de caracteres, en orden
function notasParaElModelo(chat) {
  const salida = [];
  let total = 0;
  for (const n of memoria.notas(chat).reverse()) {
    total += n.texto.length + 8;
    if (total > NOTAS_MAX_CARACTERES && salida.length) break;
    salida.unshift({ id: n.id, texto: n.texto });
  }
  return salida;
}

// Todo lo que el modelo necesita saber además del mensaje: conversación reciente, notas,
// resúmenes de días anteriores e integrantes del grupo (para poder etiquetarlos).
async function armarContexto({ chat, isGroup, excluirWaId }) {
  const ctx = { historial: [], notas: [], resumenes: [], integrantes: [], grupo: null };
  try {
    ctx.historial = memoria
      .recientes(chat, { limite: CONTEXTO_MENSAJES, horas: CONTEXTO_HORAS, excluirWaId, maxCaracteres: CONTEXTO_MAX_CARACTERES })
      .map((m) => ({ cuando: etiquetaTiempo(m.ts), nombre: m.es_bot ? BOT_NAME : m.autor, texto: mencionesANombres(m.texto) }));
    ctx.notas = notasParaElModelo(chat);
    ctx.resumenes = RESUMENES_DIAS > 0 ? memoria.resumenesRecientes(chat, { dias: RESUMENES_DIAS }) : [];
  } catch (err) {
    logger.warn({ motivo: err.message }, 'No se pudo leer la memoria para el contexto');
  }
  if (isGroup) {
    try {
      const meta = await obtenerGrupo(chat);
      ctx.grupo = { nombre: meta.subject || null, integrantes: meta.participants.length };
      ctx.integrantes = meta.participants
        .filter((p) => !isBotJid(p.id))
        .map((p) => ({
          nombre: memoria.nombreDe(normalizeJid(p.id)) || memoria.nombrePorNumero(jidToNumber(p.id)),
          mencion: `@${jidToNumber(p.id)}`,
        }))
        .filter((i) => i.nombre)
        .slice(0, 40);
    } catch (err) {
      logger.warn({ motivo: err.message }, 'No se pudo leer la info del grupo');
    }
  }
  return ctx;
}

// ---------- Procesamiento ----------

function procesarEntrante(msg, type) {
  const remoteJid = msg.key?.remoteJid;
  if (!msg.message || !remoteJid) return;
  if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) return;
  // Lo que mandó este bridge ya se guardó al enviarlo (llega como "append")
  if (msg.key.fromMe && type !== 'notify') return;

  // Desenvuelve mensajes temporales, de "ver una vez" y editados
  const contenido = normalizeMessageContent(msg.message);
  if (!contenido) return;
  const isGroup = remoteJid.endsWith('@g.us');
  const senderJid = msg.key.fromMe ? botJid() : isGroup ? msg.key.participant : remoteJid;
  if (!senderJid) return;

  // --- Ediciones y "eliminar para todos": se reflejan en la memoria ---
  const protocolo = contenido.protocolMessage;
  if (protocolo) {
    const idOriginal = protocolo.key?.id;
    try {
      if (protocolo.type === TIPO_REVOKE) {
        if (memoria.borrarMensaje(remoteJid, idOriginal)) logger.info({ chat: remoteJid }, '🗑️  Mensaje borrado también de la memoria');
      } else if (protocolo.type === TIPO_EDIT) {
        const nuevoTexto = describirMensaje(normalizeMessageContent(protocolo.editedMessage) || {});
        if (nuevoTexto) memoria.editarMensaje(remoteJid, idOriginal, nuevoTexto);
      }
    } catch (err) {
      logger.warn({ motivo: err.message }, 'No se pudo actualizar la memoria (edición/borrado)');
    }
    return;
  }

  // --- Memoria: se guarda todo lo que pasa en el chat, se conteste o no ---
  const descripcion = describirMensaje(contenido);
  if (!descripcion) return; // reacciones, votos de encuestas, etc.
  const ts = aNumero(msg.messageTimestamp) || ahoraSeg();
  try {
    if (!msg.key.fromMe) memoria.recordarNombre(normalizeJid(senderJid), msg.pushName);
    if (!MEMORIA_EXCLUIR.has(normalizeJid(senderJid))) {
      memoria.guardarMensaje({
        waId: msg.key.id,
        chat: remoteJid,
        autorJid: normalizeJid(senderJid) || null,
        autor: msg.key.fromMe ? BOT_NAME : nombreVisible(senderJid, msg.pushName),
        texto: descripcion,
        ts,
        esBot: !!msg.key.fromMe,
      });
    }
  } catch (err) {
    // Un problema con la memoria nunca puede impedir que CaDI conteste
    logger.warn({ motivo: err.message }, 'No se pudo guardar el mensaje en la memoria');
  }

  if (msg.key.fromMe) return; // lo escribieron desde el teléfono de CaDI: no se contesta
  if (type !== 'notify') return; // atrasado: queda en la memoria, pero no se contesta
  if (ahoraSeg() - ts > MAX_ANTIGUEDAD_SEG) return; // viejo, llegó después de una reconexión

  const text = textoDe(contenido);
  if (!text) return; // audios, stickers, fotos sin texto: solo memoria

  recordarRecibido(msg);

  // --- ¿El mensaje es para CaDI? ---
  // CaDI puede aparecer con su número o con su @lid, según cómo WhatsApp
  // direccione el grupo. Comparamos solo la parte de usuario (antes de @ y :).
  const users = botUsers();
  const tipo = getContentType(contenido);
  const contextInfo = (tipo && contenido[tipo]?.contextInfo) || {};
  const mentionsBot = (contextInfo.mentionedJid || []).some(isBotJid); // la etiquetaron con @
  const isReplyToBot = isBotJid(contextInfo.participant); // respondieron a un mensaje suyo
  const mentionsName = new RegExp(`\\b${escaparRegex(BOT_NAME)}\\b`, 'i').test(text); // la nombraron
  const addressedToBot = !isGroup || mentionsBot || isReplyToBot || mentionsName;

  // Sacamos el "@numero" de CaDI del texto, para que el modelo no lo lea
  const cleanText = users.reduce((t, u) => t.replaceAll(`@${u}`, ''), text).trim() || text;

  const isAdmin = ADMIN_JIDS.includes(normalizeJid(senderJid));
  const pideTodos = isGroup && regexTodos.test(text);

  // Personas etiquetadas en el mensaje (sin contar a CaDI): son el objetivo
  // de acciones como "sacá a @Juan"
  const mentionedJids = (contextInfo.mentionedJid || []).filter((jid) => !isBotJid(jid)).map(normalizeJid);

  rememberJid(senderJid);
  mentionedJids.forEach(rememberJid);

  // Una sola línea por mensaje (senderJid sirve para cargar ADMIN_JIDS en el .env)
  logger.info({ remoteJid, senderJid, pushName: msg.pushName, addressedToBot, isAdmin, pideTodos }, '📩 Mensaje entrante');

  // "@todos" sin hablarle a CaDI: lo resuelve el bridge solo, sin n8n ni Groq
  if (pideTodos && !addressedToBot) {
    convocarATodos(msg, remoteJid, isAdmin).catch((err) => logger.error({ err }, 'No se pudo etiquetar a todos'));
    return;
  }

  // Si no es para CaDI, n8n lo descartaría igual: no lo mandamos y le ahorramos trabajo
  if (!addressedToBot && !REENVIAR_TODO) return;

  // Sin await: si n8n tarda, no frena la recepción de los mensajes siguientes
  (async () => {
    let etiquetarTodos = false;
    let etiquetarTodosEspera = null;
    if (pideTodos) {
      const espera = minutosDeEsperaTodos(remoteJid, isAdmin);
      if (espera > 0) etiquetarTodosEspera = espera;
      else {
        etiquetarTodos = true;
        marcarPendienteTodos(remoteJid, msg.key.id); // la respuesta a este mensaje etiqueta a todos
      }
    }

    const contexto = await armarContexto({ chat: remoteJid, isGroup, excluirWaId: msg.key.id });

    await reenviarAN8n({
      isGroup,
      groupId: isGroup ? remoteJid : null,
      chatId: remoteJid,
      from: senderJid,
      senderJid,
      text: cleanText,
      addressedToBot,
      isAdmin,
      mentionedJids,
      messageId: msg.key.id,
      timestamp: ts,
      pushName: msg.pushName || null,
      etiquetarTodos,
      etiquetarTodosEspera,
      contexto,
    });
  })().catch((err) => logger.error({ err }, 'Error preparando el mensaje para n8n'));
}

// =====================================================================
// 5. Reenvío a n8n
// =====================================================================

// Reintenta si n8n está caído o arrancando (mientras arranca, n8n responde
// 404 porque todavía no registró los webhooks de los workflows activos).
const ESPERAS_REINTENTO_MS = [3000, 10000, 20000, 30000]; // ~1 minuto en total

async function reenviarAN8n(payload) {
  for (let intento = 0; intento <= ESPERAS_REINTENTO_MS.length; intento++) {
    try {
      const r = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(N8N_WEBHOOK_TOKEN ? { 'x-cadi-token': N8N_WEBHOOK_TOKEN } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) return;
      if (r.status === 401 || r.status === 403) {
        // Reintentar no cambia nada: el token no coincide
        logger.error(
          `❌ n8n rechazó el mensaje (HTTP ${r.status}): el token no coincide. Revisá N8N_WEBHOOK_TOKEN en el .env y la credencial Header Auth del Webhook1.`
        );
        return;
      }
      throw new Error(
        r.status === 404
          ? 'n8n respondió 404: el workflow no está activo o n8n todavía está arrancando'
          : `n8n respondió HTTP ${r.status}`
      );
    } catch (err) {
      const espera = ESPERAS_REINTENTO_MS[intento];
      if (espera === undefined) {
        logger.error({ motivo: err.message, messageId: payload.messageId }, '❌ No se pudo entregar el mensaje a n8n; se descarta');
        return;
      }
      logger.warn({ motivo: err.message }, `n8n no recibió el mensaje; reintento en ${espera / 1000}s`);
      await esperar(espera);
    }
  }
}

// =====================================================================
// 6. Servidor HTTP: lo que n8n llama para actuar (se crea UNA sola vez)
// =====================================================================

const app = express();
app.use(express.json({ limit: '1mb' }));

// Si WhatsApp se está reconectando, esperamos un rato antes de rendirnos:
// así un microcorte no hace fallar la respuesta de CaDI.
async function esperarConexion(ms = 20000) {
  const limite = Date.now() + ms;
  while (!conectado && !detenido && Date.now() < limite) await esperar(500);
  return conectado;
}

// Middleware para las herramientas: sin WhatsApp, no hay nada que hacer
async function requiereWhatsApp(req, res, next) {
  if (await esperarConexion()) return next();
  noHecho(res, 'CaDI está desconectada de WhatsApp en este momento. Probá de nuevo en un rato.');
}

// Si esta respuesta tiene que etiquetar a todos (pedido con @todos o con la herramienta),
// devuelve los JIDs de todos los integrantes y consume el pedido.
async function mencionesPendientes(jid, quotedId) {
  const clave = clavePendiente(jid, quotedId);
  if (!jid.endsWith('@g.us') || !quotedId || (pendientesTodos.get(clave) || 0) < Date.now()) return [];
  pendientesTodos.delete(clave);
  try {
    return await mencionesDeTodos(jid);
  } catch (err) {
    logger.warn({ motivo: err.message }, 'No se pudo armar la lista para etiquetar a todos');
    return [];
  }
}

// "@Juan" -> "@123456..." si Juan es un integrante conocido del grupo (por si el modelo
// escribe el nombre en vez del número que le pasamos)
function nombresAMenciones(texto, jid) {
  const meta = grupoEnCache(jid);
  if (!meta || !texto.includes('@')) return texto;
  let salida = texto;
  for (const p of meta.participants) {
    if (isBotJid(p.id)) continue;
    const nombre = memoria.nombreDe(normalizeJid(p.id)) || memoria.nombrePorNumero(jidToNumber(p.id));
    if (!nombre || nombre.length < 2) continue;
    const re = new RegExp(`@${escaparRegex(nombre)}(?![\\p{L}\\p{N}])`, 'giu');
    salida = salida.replace(re, `@${jidToNumber(p.id)}`);
  }
  return salida;
}

// n8n llama acá para que CaDI conteste
// body: { to, text, quotedId?, esRespuesta? }
//   quotedId: id del mensaje a citar (el que le hicieron a CaDI)
//   esRespuesta: false si el texto es el aviso de error de n8n (ese nunca etiqueta a todos)
app.post('/send', async (req, res) => {
  try {
    const { to, quotedId } = req.body;
    let text = limpiarSistema(req.body.text);

    if (!to || !text) {
      return res.status(400).json({ success: false, error: 'Faltan "to" o "text".' });
    }
    if (!(await esperarConexion())) {
      return res.status(503).json({ success: false, error: 'WhatsApp está desconectado; no se pudo enviar.' });
    }

    const jid = aJid(to);
    if (jid.endsWith('@g.us')) text = nombresAMenciones(text, jid);

    // Cada "@numero" del texto se manda como etiqueta real: WhatsApp muestra el nombre
    // de la persona en vez del número. Si no conocemos su JID, asumimos número de teléfono.
    const users = botUsers();
    const delTexto = [...new Set([...text.matchAll(/@(\d{6,})/g)].map((m) => m[1]))]
      .filter((n) => !users.includes(n))
      .map((n) => knownJids.get(n) || `${n}@s.whatsapp.net`);
    const esError = req.body.esRespuesta === false || req.body.esRespuesta === 'false';
    const todos = esError ? [] : await mencionesPendientes(jid, quotedId);
    const mentions = [...new Set([...delTexto, ...todos])];
    const citado = quotedId ? recibidos.get(String(quotedId)) : undefined;

    const result = await conTimeout(
      sock.sendMessage(jid, mentions.length ? { text, mentions } : { text }, citado ? { quoted: citado } : {}),
      30000,
      'sendMessage'
    );
    recordarEnviado(result);
    if (todos.length) ultimoTodos.set(jid, Date.now());
    guardarDeCaDI(jid, result, todos.length ? `${text} [etiquetó a todos]` : text);

    logger.info({ to: jid, etiquetas: mentions.length, todos: todos.length > 0, citado: !!citado }, '📤 Respuesta enviada');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Error en /send');
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sacar gente del grupo (CaDI tiene que ser admin del grupo para que esto funcione).
// participants: array de JIDs o string separado por comas.
app.post('/group/remove-participant', requiereWhatsApp, async (req, res) => {
  try {
    const { groupId, motivo } = req.body;
    if (!groupId) return noHecho(res, 'Esta acción solo funciona dentro de un grupo.');

    let participants = req.body.participants ?? req.body.participant ?? [];
    if (typeof participants === 'string') participants = participants.split(',');
    participants = participants.map((p) => p.trim()).filter(Boolean).map((p) => normalizeJid(toIndividualJid(p)));

    // Red de seguridad: nunca sacar a un admin de CaDI ni a CaDI misma,
    // aunque el modelo se equivoque
    const users = botUsers();
    const protegidos = participants.filter((p) => ADMIN_JIDS.includes(p) || users.includes(jidToNumber(p)));
    participants = participants.filter((p) => !protegidos.includes(p));

    if (participants.length === 0) {
      return noHecho(
        res,
        protegidos.length
          ? 'La persona es administradora del grupo (o es CaDI) y no se la puede sacar.'
          : 'No hay a quién sacar: hay que etiquetar (@) a la persona en el mismo mensaje.'
      );
    }

    logger.info({ participants, motivo: motivo || '(sin motivo)' }, '🚪 Sacando del grupo');
    const result = await conTimeout(
      sock.groupParticipantsUpdate(toGroupJid(groupId), participants, 'remove'),
      30000,
      'groupParticipantsUpdate'
    );
    const fallidos = result.filter((r) => r.status !== '200');

    if (fallidos.length) {
      return noHecho(res, 'WhatsApp rechazó la acción (¿CaDI es admin del grupo?).', {
        detalle: fallidos.map((f) => ({ jid: f.jid, status: f.status })),
      });
    }
    const aviso = protegidos.length ? ` Se omitieron ${protegidos.length} administrador(es), que no se pueden sacar.` : '';
    hecho(res, `se sacó del grupo a ${participants.length} persona(s).${aviso}`, {
      removidos: participants.length,
      protegidosOmitidos: protegidos.length,
    });
  } catch (err) {
    logger.error({ err }, 'Error en /group/remove-participant');
    noHecho(res, `error interno: ${err.message}`);
  }
});

// Modo "solo admins pueden escribir" (mode: "announcement" | "not_announcement")
app.post('/group/set-mode', requiereWhatsApp, async (req, res) => {
  try {
    const { groupId, mode } = req.body;
    if (!groupId) return noHecho(res, 'Esta acción solo funciona dentro de un grupo.');
    if (!['announcement', 'not_announcement'].includes(mode)) {
      return noHecho(res, "modo inválido: tiene que ser 'announcement' o 'not_announcement'.");
    }
    await conTimeout(sock.groupSettingUpdate(toGroupJid(groupId), mode), 30000, 'groupSettingUpdate');
    hecho(res, mode === 'announcement' ? 'ahora solo los admins pueden escribir.' : 'ahora todos pueden escribir.');
  } catch (err) {
    logger.error({ err }, 'Error en /group/set-mode');
    noHecho(res, `error interno (¿CaDI es admin del grupo?): ${err.message}`);
  }
});

// Encuesta (cualquier integrante puede crear una, así que está disponible para todos)
// body: { chatId | groupId, question, options, selectableCount? }
app.post('/group/poll', requiereWhatsApp, async (req, res) => {
  try {
    const destino = req.body.chatId || req.body.groupId;
    const { question, selectableCount = 1 } = req.body;
    if (!destino) return noHecho(res, 'Falta el chat donde mandar la encuesta.');
    // options: array o string separado por "|" (más fácil de armar desde n8n)
    let options = req.body.options ?? [];
    if (typeof options === 'string') options = options.split('|');
    options = [...new Set(options.map((o) => recortar(o, 100)).filter(Boolean))];
    if (!question || options.length < 2 || options.length > 12) {
      return noHecho(res, 'La encuesta necesita una pregunta y entre 2 y 12 opciones distintas.');
    }
    const jid = aJid(destino);
    const nombre = recortar(question, 250);
    const result = await conTimeout(
      sock.sendMessage(jid, {
        poll: { name: nombre, values: options, selectableCount: Math.min(Number(selectableCount) || 1, options.length) },
      }),
      30000,
      'sendMessage (encuesta)'
    );
    recordarEnviado(result);
    guardarDeCaDI(jid, result, `[encuesta] ${nombre} — ${options.join(' / ')}`);
    hecho(res, `se envió la encuesta con ${options.length} opciones.`);
  } catch (err) {
    logger.error({ err }, 'Error en /group/poll');
    noHecho(res, `error interno: ${err.message}`);
  }
});

// Evento de WhatsApp (nombre, fecha y hora; la gente confirma si va). Cualquier integrante
// puede crear uno. Baileys 6.7.23 no lo trae armado, así que se arma igual que en Baileys 7.
// body: { groupId, nombre, inicio, fin?, descripcion?, lugar? }   (fechas ISO; sin zona = hora de Tucumán)
app.post('/group/event', requiereWhatsApp, async (req, res) => {
  try {
    const { groupId } = req.body;
    if (!groupId || !String(groupId).includes('@g.us')) return noHecho(res, 'Los eventos solo se pueden crear dentro de un grupo.');
    const nombre = recortar(req.body.nombre, 100);
    if (!nombre) return noHecho(res, 'El evento necesita un nombre.');

    const inicio = parsearFecha(req.body.inicio);
    if (!inicio) {
      return noHecho(res, `no entendí la fecha de inicio "${req.body.inicio}". Tiene que tener el formato AAAA-MM-DDTHH:MM:00-03:00.`);
    }
    const ahora = ahoraSeg();
    if (inicio < ahora - 300) return noHecho(res, `la fecha de inicio (${fechaHoraLarga(inicio)}) ya pasó.`);
    if (inicio > ahora + 366 * 86400) return noHecho(res, 'la fecha de inicio es dentro de más de un año.');
    let fin = parsearFecha(req.body.fin);
    if (fin && fin <= inicio) fin = null; // un fin anterior al inicio se ignora

    const descripcion = recortar(req.body.descripcion, 1000);
    const lugar = recortar(req.body.lugar, 120);
    const jid = toGroupJid(groupId);

    const msg = generateWAMessageFromContent(
      jid,
      {
        // La "clave secreta" del evento: WhatsApp la usa para cifrar las confirmaciones (igual que en las encuestas)
        messageContextInfo: { messageSecret: randomBytes(32) },
        eventMessage: {
          name: nombre,
          description: descripcion || undefined,
          startTime: inicio,
          endTime: fin || undefined,
          location: lugar ? { name: lugar } : undefined,
          isCanceled: false,
          extraGuestsAllowed: false,
          isScheduleCall: false,
        },
      },
      { userJid: sock.user?.id }
    );
    await conTimeout(
      sock.relayMessage(jid, msg.message, {
        messageId: msg.key.id,
        additionalAttributes: { type: 'event' },
        additionalNodes: [{ tag: 'meta', attrs: { event_type: 'creation' } }],
      }),
      30000,
      'relayMessage (evento)'
    );
    recordarEnviado(msg);
    const cuando = fechaHoraLarga(inicio);
    guardarDeCaDI(jid, msg, `[evento] ${nombre} — ${cuando}${lugar ? ` en ${lugar}` : ''}`);
    logger.info({ jid, nombre, cuando }, '📅 Evento creado');
    hecho(res, `se creó el evento "${nombre}" para el ${cuando}${lugar ? ` en ${lugar}` : ''}.`);
  } catch (err) {
    logger.error({ err }, 'Error en /group/event');
    noHecho(res, `error interno: ${err.message}`);
  }
});

// Hace que la respuesta de CaDI a este mensaje etiquete a todos
// body: { groupId, messageId, isAdmin }
app.post('/group/mencionar-todos', requiereWhatsApp, async (req, res) => {
  try {
    const { groupId } = req.body;
    if (!groupId || !String(groupId).includes('@g.us')) return noHecho(res, 'Solo se puede etiquetar a todos dentro de un grupo.');
    const jid = toGroupJid(groupId);
    const espera = minutosDeEsperaTodos(jid, esVerdadero(req.body.isAdmin));
    if (espera > 0) {
      return noHecho(res, `ya se etiquetó a todos hace poco; faltan ${espera} minuto(s) para poder hacerlo de nuevo.`);
    }
    if (!req.body.messageId) return noHecho(res, 'falta el id del mensaje.');
    const menciones = await mencionesDeTodos(jid);
    marcarPendienteTodos(jid, req.body.messageId);
    hecho(
      res,
      `tu respuesta va a notificar a las ${menciones.length} personas del grupo. Escribí el aviso en tu respuesta, sin poner ningún @número.`
    );
  } catch (err) {
    logger.error({ err }, 'Error en /group/mencionar-todos');
    noHecho(res, `error interno: ${err.message}`);
  }
});

// Ubicación (pin del mapa). Busca el lugar en OpenStreetMap, primero en Tucumán.
// body: { chatId | groupId, consulta }
app.post('/ubicacion', requiereWhatsApp, async (req, res) => {
  try {
    const destino = req.body.chatId || req.body.groupId;
    const consulta = recortar(req.body.consulta, 200);
    if (!destino) return noHecho(res, 'Falta el chat de destino.');
    if (!consulta) return noHecho(res, 'Falta qué lugar buscar.');

    const lugar = await buscarLugar(consulta);
    if (!lugar) {
      return noHecho(res, `no encontré "${consulta}" en el mapa. Probá con una dirección o un nombre más preciso (y la ciudad).`);
    }
    const jid = aJid(destino);
    const result = await conTimeout(
      sock.sendMessage(jid, {
        location: { degreesLatitude: lugar.lat, degreesLongitude: lugar.lon, name: lugar.nombre, address: lugar.direccion },
      }),
      30000,
      'sendMessage (ubicación)'
    );
    recordarEnviado(result);
    const detalle = lugar.direccion ? `${lugar.nombre} (${lugar.direccion})` : lugar.nombre;
    guardarDeCaDI(jid, result, `[ubicación] ${detalle}`);
    hecho(res, `se envió la ubicación de ${detalle}.`);
  } catch (err) {
    logger.error({ err }, 'Error en /ubicacion');
    noHecho(res, `no se pudo buscar o mandar la ubicación: ${err.message}`);
  }
});

// Imagen generada con IA. Con tope diario por chat y espera por persona (cuidan la cuota gratis).
// body: { chatId | groupId, prompt, solicitante?, isAdmin? }
const imagenesPorDia = new Map(); // "chat|fecha" -> cantidad
const ultimaImagenDe = new Map(); // solicitante -> ms

const tipoDeImagen = (b) =>
  b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/jpeg';

// Miniatura y medidas de la imagen. Baileys 6.7.23 las calcula solo, pero a veces lee el archivo
// temporal antes de que termine de escribirse y la imagen llega sin vista previa. Calculándolas
// acá (con sharp, que ya viene con Baileys) siempre llegan bien.
async function datosDeImagen(buffer) {
  try {
    const { default: sharp } = await import('sharp');
    const { width, height } = await sharp(buffer).metadata();
    const jpegThumbnail = await sharp(buffer).resize(32).jpeg({ quality: 50 }).toBuffer();
    return { jpegThumbnail, width, height };
  } catch {
    return {}; // sin sharp, Baileys lo intenta por su cuenta
  }
}

app.post('/imagen', requiereWhatsApp, async (req, res) => {
  const destino = req.body.chatId || req.body.groupId;
  const solicitante = req.body.solicitante || destino;
  try {
    const prompt = recortar(req.body.prompt, 1500);
    const esAdmin = esVerdadero(req.body.isAdmin);
    if (!destino) return noHecho(res, 'Falta el chat de destino.');
    if (prompt.length < 3) return noHecho(res, 'Falta la descripción de la imagen.');
    const falta = imagenesNoConfiguradas();
    if (falta) return noHecho(res, `la creación de imágenes no está configurada (${falta}).`);

    const hoy = fechaISO(ahoraSeg());
    const clave = `${destino}|${hoy}`;
    if (!esAdmin && IMAGEN_MAX_DIA > 0 && (imagenesPorDia.get(clave) || 0) >= IMAGEN_MAX_DIA) {
      return noHecho(res, `ya se generaron ${IMAGEN_MAX_DIA} imágenes hoy en este chat, que es el máximo diario.`);
    }
    const espera = (ultimaImagenDe.get(solicitante) || 0) + IMAGEN_ESPERA_SEG * 1000 - Date.now();
    if (!esAdmin && espera > 0) return noHecho(res, `hay que esperar ${Math.ceil(espera / 1000)} segundos entre imágenes.`);
    ultimaImagenDe.set(solicitante, Date.now());

    const imagen = await generarImagen(prompt);
    const jid = aJid(destino);
    const extra = await datosDeImagen(imagen);
    const result = await conTimeout(
      sock.sendMessage(jid, { image: imagen, mimetype: tipoDeImagen(imagen), ...extra }),
      60000,
      'sendMessage (imagen)'
    );
    recordarEnviado(result);

    for (const k of imagenesPorDia.keys()) if (!k.endsWith(`|${hoy}`)) imagenesPorDia.delete(k); // limpia días viejos
    imagenesPorDia.set(clave, (imagenesPorDia.get(clave) || 0) + 1);
    guardarDeCaDI(jid, result, `[imagen generada] ${recortar(prompt, 200)}`);
    logger.info({ jid, bytes: imagen.length }, '🎨 Imagen enviada');
    hecho(res, 'se generó la imagen y ya se envió al chat.');
  } catch (err) {
    ultimaImagenDe.delete(solicitante); // si falló, no tiene que esperar para reintentar
    logger.error({ err }, 'Error en /imagen');
    noHecho(res, `no se pudo crear la imagen: ${err.message}`);
  }
});

// ---------- Memoria ----------

// Busca en el historial del chat donde se hizo la pregunta (nunca en otros chats)
// body: { chatId, consulta?, desde?, hasta?, autor? }
app.post('/memoria/buscar', (req, res) => {
  try {
    const chat = req.body.chatId;
    if (!chat) return noHecho(res, 'Falta el chat.');
    if (!memoria.activa) return noHecho(res, `la memoria está apagada (${memoria.motivo}).`);
    const desde = parsearFecha(req.body.desde);
    const hasta = parsearFecha(req.body.hasta, { finDelDia: true });
    const r = memoria.buscar(chat, {
      consulta: String(req.body.consulta ?? ''),
      desde,
      hasta,
      autor: String(req.body.autor ?? ''),
    });
    res.json({ success: true, total: r.total, resultado: r.texto });
  } catch (err) {
    logger.error({ err }, 'Error en /memoria/buscar');
    noHecho(res, `error interno: ${err.message}`);
  }
});

// Guarda una nota permanente del chat. body: { chatId, texto, autor? }
app.post('/memoria/nota', (req, res) => {
  try {
    const r = memoria.guardarNota(req.body.chatId, limpiarSistema(req.body.texto), req.body.autor || null);
    if (!r.ok) return noHecho(res, r.error);
    hecho(res, `se guardó la nota #${r.id}.`);
  } catch (err) {
    logger.error({ err }, 'Error en /memoria/nota');
    noHecho(res, `error interno: ${err.message}`);
  }
});

// Borra una nota por número. body: { chatId, id }
app.post('/memoria/nota/borrar', (req, res) => {
  try {
    const id = Number(String(req.body.id ?? '').replace(/\D/g, ''));
    if (!id) return noHecho(res, 'Falta el número de la nota.');
    if (!memoria.borrarNota(req.body.chatId, id)) return noHecho(res, `no existe la nota #${id} en este chat.`);
    hecho(res, `se borró la nota #${id}.`);
  } catch (err) {
    logger.error({ err }, 'Error en /memoria/nota/borrar');
    noHecho(res, `error interno: ${err.message}`);
  }
});

// Para el workflow "CaDI - Resumen diario": días anteriores que todavía no tienen resumen
app.get('/memoria/pendientes', async (req, res) => {
  try {
    const nombres = new Map();
    const lista = memoria.pendientesDeResumen({
      maxDias: num(req.query.dias, 7),
      maxCaracteres: RESUMEN_MAX_CARACTERES,
      nombreDeChat: (chat) => nombres.get(chat) ?? null,
    });
    // Nombre de cada chat (si WhatsApp está conectado), para que el resumen tenga contexto
    for (const chat of new Set(lista.map((p) => p.chat))) {
      let nombre = null;
      if (chat.endsWith('@g.us')) {
        if (conectado) nombre = (await obtenerGrupo(chat).catch(() => null))?.subject || null;
      } else nombre = memoria.nombreDe(chat) || memoria.nombrePorNumero(jidToNumber(chat));
      nombres.set(chat, nombre);
    }
    const pendientes = lista.slice(0, num(req.query.limite, 20)).map((p) => ({ ...p, nombreChat: nombres.get(p.chat) ?? null }));
    res.json({ success: true, cantidad: pendientes.length, pendientes });
  } catch (err) {
    logger.error({ err }, 'Error en /memoria/pendientes');
    res.status(500).json({ success: false, error: err.message, pendientes: [] });
  }
});

// Guarda el resumen de un día. body: { chat, fecha: "YYYY-MM-DD", parte?, texto }
app.post('/memoria/resumen', (req, res) => {
  try {
    const { chat, fecha, parte } = req.body;
    const texto = limpiarSistema(req.body.texto);
    if (!memoria.guardarResumen(chat, fecha, parte, texto)) return noHecho(res, 'faltan datos (chat, fecha YYYY-MM-DD o texto).');
    logger.info({ chat, fecha, parte }, '📝 Resumen diario guardado');
    hecho(res, 'resumen guardado.');
  } catch (err) {
    logger.error({ err }, 'Error en /memoria/resumen');
    noHecho(res, `error interno: ${err.message}`);
  }
});

// Lista los grupos donde está CaDI (sirve para saber el id de un grupo, por ejemplo para importar el chat)
app.get('/grupos', requiereWhatsApp, async (req, res) => {
  try {
    const grupos = await conTimeout(sock.groupFetchAllParticipating(), 20000, 'groupFetchAllParticipating');
    res.json(Object.values(grupos).map((g) => ({ id: g.id, nombre: g.subject, integrantes: g.participants?.length ?? null })));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Estado real: responde 503 si WhatsApp no está conectado (sirve para monitorear)
app.get('/health', (req, res) => {
  const seg = (desde) => (desde ? Math.round((Date.now() - desde) / 1000) : null);
  let estadoMemoria;
  try {
    estadoMemoria = memoria.estadisticas();
  } catch (err) {
    estadoMemoria = { activa: false, error: err.message };
  }
  res.status(conectado ? 200 : 503).json({
    status: conectado ? 'ok' : detenido ? 'detenido' : 'reconectando',
    whatsapp: conectado,
    motivoDetenido,
    conectadoHaceSeg: seg(conectadoDesde),
    procesoActivoHaceSeg: seg(iniciadoEn),
    reconexiones: reconexionesTotales,
    memoria: estadoMemoria,
    imagenes: imagenesNoConfiguradas() || 'ok',
  });
});

// Solo localhost: los endpoints de admin no quedan expuestos a la red.
// Escuchamos en las dos direcciones locales porque, en Windows, "localhost"
// suele resolverse a IPv6 (::1) y no a IPv4 (127.0.0.1).
const servidor = app.listen(BRIDGE_PORT, '127.0.0.1');
servidor.on('listening', () => logger.info(`Bridge escuchando en http://localhost:${BRIDGE_PORT}`));
servidor.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.fatal(`❌ El puerto ${BRIDGE_PORT} ya está en uso: seguramente ya hay otro bridge corriendo. Cerralo antes de abrir este.`);
  } else {
    logger.fatal({ err }, 'No se pudo levantar el servidor HTTP');
  }
  process.exit(1);
});
const ipv6 = app.listen(BRIDGE_PORT, '::1');
ipv6.on('error', (err) => {
  // Si la compu no tiene IPv6, alcanza con 127.0.0.1
  logger.warn({ code: err.code }, 'No se pudo escuchar en ::1 (IPv6); se sigue solo con 127.0.0.1');
});

// =====================================================================
// 7. Vigilancia y arranque
// =====================================================================

// Watchdog: a veces Baileys se queda "conectando" para siempre sin avisar que
// se cerró. Si pasan 2 minutos sin conexión y sin reintento en curso, forzamos uno.
setInterval(() => {
  if (!conectado && !detenido && !reconexionPendiente && Date.now() - ultimoIntento > 120000) {
    programarReconexion('watchdog: 2 minutos sin conexión', true);
  }
}, 30000);

// Limpieza de la memoria: si MEMORIA_DIAS > 0, borra los mensajes más viejos (una vez por día)
function purgarMemoria() {
  try {
    const borrados = memoria.purgar(MEMORIA_DIAS);
    if (borrados) logger.info(`🧹 Memoria: se borraron ${borrados} mensajes de más de ${MEMORIA_DIAS} días`);
  } catch (err) {
    logger.warn({ motivo: err.message }, 'No se pudo limpiar la memoria');
  }
}
purgarMemoria();
setInterval(purgarMemoria, 24 * 3600 * 1000).unref();

// Errores que nadie atrapó: se registran en vez de matar el proceso en silencio
process.on('unhandledRejection', (err) => logger.error({ err }, 'Promesa rechazada sin manejar'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Error inesperado: se cierra el proceso (PM2 lo vuelve a levantar)');
  process.exit(1);
});

// Cierre prolijo con Ctrl+C o cuando PM2 lo detiene
for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    logger.info('Cerrando el bridge...');
    detenido = true;
    try { sock?.end(undefined); } catch {}
    servidor.close();
    ipv6.close();
    memoria.cerrar();
    setTimeout(() => process.exit(0), 500);
  });
}

conectarWhatsApp().catch((err) => {
  logger.error({ err }, 'Falló la primera conexión');
  programarReconexion('falló la primera conexión');
});
