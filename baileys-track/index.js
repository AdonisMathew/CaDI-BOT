// CaDI - Baileys Bridge
// Puente entre WhatsApp (vía Baileys, protocolo no oficial) y n8n.
// n8n sigue siendo el cerebro (Groq + Tavily + personalidad); este script
// solo se encarga de la mensajería cruda: recibir y mandar.
//
// Estructura:
//   1. Config y helpers
//   2. Conexión con WhatsApp (se puede recrear muchas veces: reconexiones)
//   3. Reenvío a n8n (con timeout y reintentos)
//   4. Servidor HTTP (se crea UNA sola vez y siempre usa el socket actual)

import 'dotenv/config';
import express from 'express';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from 'baileys';

// =====================================================================
// 1. Config y helpers
// =====================================================================

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/cadi-grupo';
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT) || 3001;
const USE_PAIRING_CODE = process.env.USE_PAIRING_CODE === 'true';
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER || ''; // ej: 5493811234567 (sin +, sin espacios)
const BOT_NAME = process.env.BOT_NAME || 'CaDI';
// Mensajes más viejos que esto (en segundos) se ignoran. Evita que, al reconectar
// después de un corte, CaDI conteste de golpe a todo lo que se dijo mientras no estaba.
const MAX_ANTIGUEDAD_SEG = Number(process.env.MAX_ANTIGUEDAD_SEG) || 300;
// En "false" (recomendado), solo se mandan a n8n los mensajes dirigidos a CaDI.
// En un grupo activo, mandar todo crea una ejecución de n8n por cada mensaje y lo carga
// sin necesidad. Se pondrá en "true" cuando exista la memoria/resumen del grupo.
const REENVIAR_TODO = process.env.REENVIAR_TODO === 'true';

// Nuestro logger (info) y el de Baileys (warn): Baileys en "info" escribe muchísimo,
// y en Windows tanta salida por consola hace todo más lento.
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baileysLogger = pino({ level: process.env.LOG_LEVEL_BAILEYS || 'warn' });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

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

// JIDs que vimos en mensajes entrantes (remitentes y etiquetados): "735900..." -> "735900...@lid".
// Sirve para que, cuando CaDI escribe "@735900...", WhatsApp lo muestre como etiqueta real.
const knownJids = new Map();
const rememberJid = (jid) => { if (jid) knownJids.set(jidToNumber(jid), normalizeJid(jid)); };
ADMIN_JIDS.forEach(rememberJid); // los admins se conocen desde el arranque

// Respuesta para las herramientas de n8n. Siempre HTTP 200 con un campo "success" y un
// "resultado" en texto claro: si respondemos 4xx, n8n trata el error como falla del nodo y
// el agente puede no recibir el motivo (y terminar inventando que la acción salió bien).
const hecho = (res, resultado, extra = {}) => res.json({ success: true, resultado: `HECHO: ${resultado}`, ...extra });
const noHecho = (res, error, extra = {}) =>
  res.json({ success: false, resultado: `NO SE REALIZÓ. Motivo: ${error}`, error, ...extra });

// =====================================================================
// 2. Conexión con WhatsApp
// =====================================================================

// Estado compartido. El servidor HTTP lee SIEMPRE de acá, así que después de
// una reconexión usa el socket nuevo (antes se quedaba con el viejo, ya muerto).
let sock = null;
let conectado = false;
let detenido = false;         // true si no tiene sentido reconectar (logout / otra sesión)
let motivoDetenido = null;
let reconexionPendiente = null;
let intentosSeguidos = 0;     // para espaciar los reintentos si WhatsApp sigue fallando
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

const botUsers = () => {
  const me = sock?.authState?.creds?.me || {};
  return [me.id, me.lid].filter(Boolean).map(jidToNumber);
};

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
    printQRInTerminal: false,     // manejamos el QR nosotros abajo, más confiable entre versiones
    markOnlineOnConnect: false,   // así el teléfono de CaDI sigue recibiendo notificaciones
    getMessage: async (key) => enviados.get(key.id),
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

  // --- Mensajes entrantes: se los pasamos a n8n ---
  nuevo.ev.on('messages.upsert', ({ messages, type }) => {
    if (!esElActual() || type !== 'notify') return;

    for (const msg of messages) {
      try {
        procesarEntrante(msg);
      } catch (err) {
        // Un mensaje raro no puede tirar abajo al resto
        logger.error({ err }, 'Error procesando un mensaje entrante');
      }
    }
  });
}

function procesarEntrante(msg) {
  if (!msg.message || msg.key.fromMe) return; // ignorar propios mensajes (evita loops)

  const antiguedad = Date.now() / 1000 - Number(msg.messageTimestamp || 0);
  if (antiguedad > MAX_ANTIGUEDAD_SEG) return; // mensaje viejo, llegado después de una reconexión

  const remoteJid = msg.key.remoteJid;
  if (remoteJid === 'status@broadcast') return; // estados de WhatsApp
  const isGroup = remoteJid.endsWith('@g.us');
  const senderJid = isGroup ? msg.key.participant : remoteJid;

  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    '';

  if (!text) return; // por ahora ignoramos audios/imágenes sin texto

  // --- ¿El mensaje es para CaDI? ---
  // CaDI puede aparecer con su número o con su @lid, según cómo WhatsApp
  // direccione el grupo. Comparamos solo la parte de usuario (antes de @ y :).
  const users = botUsers();
  const isBot = (jid) => !!jid && users.includes(jidToNumber(jid));

  const contextInfo =
    msg.message.extendedTextMessage?.contextInfo ||
    msg.message.imageMessage?.contextInfo ||
    {};
  const mentionsBot = (contextInfo.mentionedJid || []).some(isBot); // la etiquetaron con @
  const isReplyToBot = isBot(contextInfo.participant);               // respondieron a un mensaje suyo
  const mentionsName = new RegExp(`\\b${BOT_NAME}\\b`, 'i').test(text); // la nombraron
  const addressedToBot = !isGroup || mentionsBot || isReplyToBot || mentionsName;

  // Sacamos el "@numero" de CaDI del texto, para que el modelo no lo lea
  const cleanText = users.reduce((t, u) => t.replaceAll(`@${u}`, ''), text).trim() || text;

  const isAdmin = ADMIN_JIDS.includes(normalizeJid(senderJid));

  // Personas etiquetadas en el mensaje (sin contar a CaDI): son el objetivo
  // de acciones como "sacá a @Juan"
  const mentionedJids = (contextInfo.mentionedJid || [])
    .filter((jid) => !isBot(jid))
    .map(normalizeJid);

  rememberJid(senderJid);
  mentionedJids.forEach(rememberJid);

  // Una sola línea por mensaje (senderJid sirve para cargar ADMIN_JIDS en el .env)
  logger.info(
    { remoteJid, senderJid, pushName: msg.pushName, addressedToBot, isAdmin },
    '📩 Mensaje entrante'
  );

  // Si no es para CaDI, n8n lo descartaría igual: no lo mandamos y le ahorramos trabajo
  if (!addressedToBot && !REENVIAR_TODO) return;

  const payload = {
    isGroup,
    groupId: isGroup ? remoteJid : null,
    from: senderJid,
    senderJid,
    text: cleanText,
    addressedToBot,
    isAdmin,
    mentionedJids,
    messageId: msg.key.id,
    timestamp: msg.messageTimestamp,
    pushName: msg.pushName || null,
  };

  // Sin await: si n8n tarda, no frena la recepción de los mensajes siguientes
  reenviarAN8n(payload);
}

// =====================================================================
// 3. Reenvío a n8n
// =====================================================================

// Reintenta si n8n está caído o arrancando (mientras arranca, n8n responde
// 404 porque todavía no registró los webhooks de los workflows activos).
const ESPERAS_REINTENTO_MS = [3000, 10000, 20000, 30000]; // ~1 minuto en total

async function reenviarAN8n(payload) {
  for (let intento = 0; intento <= ESPERAS_REINTENTO_MS.length; intento++) {
    try {
      const r = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) return;
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
// 4. Servidor HTTP: lo que n8n llama para actuar (se crea UNA sola vez)
// =====================================================================

const app = express();
app.use(express.json());

// Si WhatsApp se está reconectando, esperamos un rato antes de rendirnos:
// así un microcorte no hace fallar la respuesta de CaDI.
async function esperarConexion(ms = 20000) {
  const limite = Date.now() + ms;
  while (!conectado && !detenido && Date.now() < limite) await esperar(500);
  return conectado;
}

// n8n llama acá para que CaDI conteste
app.post('/send', async (req, res) => {
  try {
    const { to } = req.body;
    // Red de seguridad: si el modelo repite la etiqueta interna de permisos, se borra antes de enviar
    const text = String(req.body.text ?? '')
      .replace(/\[\s*SISTEMA\b[^\]]*\]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .trim();

    if (!to || !text) {
      return res.status(400).json({ success: false, error: 'Faltan "to" o "text".' });
    }
    if (!(await esperarConexion())) {
      return res.status(503).json({ success: false, error: 'WhatsApp está desconectado; no se pudo enviar.' });
    }

    const jid = to.includes('@g.us') ? toGroupJid(to) : toIndividualJid(to);

    // Cada "@numero" del texto se manda como etiqueta real: WhatsApp muestra el nombre
    // de la persona en vez del número. Si no conocemos su JID, asumimos número de teléfono.
    const users = botUsers();
    const mentions = [...new Set([...text.matchAll(/@(\d{6,})/g)].map((m) => m[1]))]
      .filter((n) => !users.includes(n))
      .map((n) => knownJids.get(n) || `${n}@s.whatsapp.net`);

    const result = await conTimeout(
      sock.sendMessage(jid, mentions.length ? { text, mentions } : { text }),
      30000,
      'sendMessage'
    );
    recordarEnviado(result);

    logger.info({ to: jid, etiquetas: mentions.length }, '📤 Respuesta enviada');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Error en /send');
    res.status(500).json({ success: false, error: err.message });
  }
});

// Middleware para las herramientas de grupo: sin WhatsApp, no hay nada que hacer
async function requiereWhatsApp(req, res, next) {
  if (await esperarConexion()) return next();
  noHecho(res, 'CaDI está desconectada de WhatsApp en este momento. Probá de nuevo en un rato.');
}

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

// Encuesta
app.post('/group/poll', requiereWhatsApp, async (req, res) => {
  try {
    const { groupId, question, selectableCount = 1 } = req.body;
    if (!groupId) return noHecho(res, 'Esta acción solo funciona dentro de un grupo.');
    // options: array o string separado por "|" (más fácil de armar desde n8n)
    let options = req.body.options ?? [];
    if (typeof options === 'string') options = options.split('|');
    options = options.map((o) => String(o).trim()).filter(Boolean);
    if (!question || options.length < 2 || options.length > 12) {
      return noHecho(res, 'La encuesta necesita una pregunta y entre 2 y 12 opciones.');
    }
    const result = await conTimeout(
      sock.sendMessage(toGroupJid(groupId), {
        poll: { name: question, values: options, selectableCount: Number(selectableCount) || 1 },
      }),
      30000,
      'sendMessage (encuesta)'
    );
    recordarEnviado(result);
    hecho(res, `se envió la encuesta con ${options.length} opciones.`);
  } catch (err) {
    logger.error({ err }, 'Error en /group/poll');
    noHecho(res, `error interno: ${err.message}`);
  }
});

// Estado real: responde 503 si WhatsApp no está conectado (sirve para monitorear)
app.get('/health', (req, res) => {
  const seg = (desde) => (desde ? Math.round((Date.now() - desde) / 1000) : null);
  res.status(conectado ? 200 : 503).json({
    status: conectado ? 'ok' : detenido ? 'detenido' : 'reconectando',
    whatsapp: conectado,
    motivoDetenido,
    conectadoHaceSeg: seg(conectadoDesde),
    procesoActivoHaceSeg: seg(iniciadoEn),
    reconexiones: reconexionesTotales,
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
// Vigilancia y arranque
// =====================================================================

// Watchdog: a veces Baileys se queda "conectando" para siempre sin avisar que
// se cerró. Si pasan 2 minutos sin conexión y sin reintento en curso, forzamos uno.
setInterval(() => {
  if (!conectado && !detenido && !reconexionPendiente && Date.now() - ultimoIntento > 120000) {
    programarReconexion('watchdog: 2 minutos sin conexión', true);
  }
}, 30000);

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
    setTimeout(() => process.exit(0), 500);
  });
}

conectarWhatsApp().catch((err) => {
  logger.error({ err }, 'Falló la primera conexión');
  programarReconexion('falló la primera conexión');
});
