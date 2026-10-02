// CaDI - Baileys Bridge
// Puente entre WhatsApp (vía Baileys, protocolo no oficial) y n8n.
// n8n sigue siendo el cerebro (Groq + Tavily + personalidad); este script
// solo se encarga de la mensajería cruda: recibir y mandar.

import 'dotenv/config';
import express from 'express';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from 'baileys';
import { Boom } from '@hapi/boom';

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/cadi-grupo';
const BRIDGE_PORT = process.env.BRIDGE_PORT || 3001;
const USE_PAIRING_CODE = process.env.USE_PAIRING_CODE === 'true';
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER || ''; // ej: 5493811234567 (sin +, sin espacios)
const BOT_NAME = process.env.BOT_NAME || 'CaDI';

const logger = pino({ level: 'info' });

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

// ---------- Arranque de la conexión con WhatsApp ----------

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false, // manejamos el QR nosotros abajo, más confiable entre versiones
  });

  // --- Vinculación: QR o código de emparejamiento ---
  if (USE_PAIRING_CODE && PAIRING_PHONE_NUMBER && !sock.authState.creds.registered) {
    // Se pide una sola vez; después de vincular, las credenciales quedan guardadas en auth_info_baileys/
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIRING_PHONE_NUMBER);
        console.log('\n=== CÓDIGO DE EMPAREJAMIENTO ===');
        console.log(`   ${code}`);
        console.log('Ingresalo en WhatsApp Business → Dispositivos vinculados → Vincular con número de teléfono\n');
      } catch (err) {
        logger.error({ err }, 'No se pudo solicitar el código de emparejamiento');
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !USE_PAIRING_CODE) {
      console.log('\n=== ESCANEÁ ESTE QR DESDE WHATSAPP BUSINESS (Dispositivos vinculados) ===\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({ statusCode }, 'Conexión cerrada');
      if (shouldReconnect) {
        startBridge();
      } else {
        logger.error('Sesión desvinculada (logout). Borrá auth_info_baileys/ y volvé a escanear el QR.');
      }
    } else if (connection === 'open') {
      logger.info('✅ Conectado a WhatsApp. CaDI está en línea.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // --- Mensajes entrantes: se los pasamos a n8n tal cual ---
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue; // ignorar propios mensajes (evita loops)

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');
      const senderJid = isGroup ? msg.key.participant : remoteJid;

      console.log('\n========== MENSAJE ENTRANTE ==========');
      console.log('remoteJid:', remoteJid);
      console.log('senderJid:', senderJid);
      console.log('isGroup:', isGroup);
      console.log('======================================\n');

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      if (!text) continue; // por ahora ignoramos audios/imágenes sin texto

      // --- ¿El mensaje es para CaDI? ---
      // CaDI puede aparecer con su número o con su @lid, según cómo WhatsApp
      // direccione el grupo. Comparamos solo la parte de usuario (antes de @ y :).
      const me = sock.authState.creds.me || {};
      const botUsers = [me.id, me.lid].filter(Boolean).map(jidToNumber);
      const isBot = (jid) => !!jid && botUsers.includes(jidToNumber(jid));

      const contextInfo =
        msg.message.extendedTextMessage?.contextInfo ||
        msg.message.imageMessage?.contextInfo ||
        {};
      const mentionsBot = (contextInfo.mentionedJid || []).some(isBot); // la etiquetaron con @
      const isReplyToBot = isBot(contextInfo.participant);               // respondieron a un mensaje suyo
      const mentionsName = new RegExp(`\\b${BOT_NAME}\\b`, 'i').test(text); // la nombraron
      const addressedToBot = !isGroup || mentionsBot || isReplyToBot || mentionsName;

      // Sacamos el "@numero" de CaDI del texto, para que el modelo no lo lea
      const cleanText = botUsers
        .reduce((t, u) => t.replaceAll(`@${u}`, ''), text)
        .trim() || text;

      const isAdmin = ADMIN_JIDS.includes(normalizeJid(senderJid));

      // Personas etiquetadas en el mensaje (sin contar a CaDI): son el objetivo
      // de acciones como "sacá a @Juan"
      const mentionedJids = (contextInfo.mentionedJid || [])
        .filter((jid) => !isBot(jid))
        .map(normalizeJid);

      rememberJid(senderJid);
      mentionedJids.forEach(rememberJid);

      console.log('addressedToBot:', addressedToBot, '| isAdmin:', isAdmin);

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

      try {
        await fetch(N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        logger.error({ err }, 'No se pudo reenviar el mensaje a n8n');
      }
    }
  });

  // ---------- Servidor HTTP: lo que n8n llama para actuar ----------
  const app = express();
  app.use(express.json());

  // n8n llama acá para que CaDI conteste
  app.post('/send', async (req, res) => {
  try {
    console.log('\n========== /send ==========');
    console.log('Body recibido:', req.body);

    const { to } = req.body;
    // Red de seguridad: si el modelo repite la etiqueta interna de permisos, se borra antes de enviar
    const text = String(req.body.text ?? '')
      .replace(/\[\s*SISTEMA\b[^\]]*\]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .trim();

    console.log('TO recibido:', to);
    console.log('TEXT recibido:', text);

    const jid = to.includes('@g.us')
      ? toGroupJid(to)
      : toIndividualJid(to);

    console.log('JID final:', jid);
    console.log('Intentando enviar...');

    // Cada "@numero" del texto se manda como etiqueta real: WhatsApp muestra el nombre
    // de la persona en vez del número. Si no conocemos su JID, asumimos número de teléfono.
    const me = sock.authState.creds.me || {};
    const botUsers = [me.id, me.lid].filter(Boolean).map(jidToNumber);
    const mentions = [...new Set([...String(text).matchAll(/@(\d{6,})/g)].map((m) => m[1]))]
      .filter((n) => !botUsers.includes(n))
      .map((n) => knownJids.get(n) || `${n}@s.whatsapp.net`);
    console.log('Etiquetas:', mentions);

    const result = await sock.sendMessage(jid, mentions.length ? { text, mentions } : { text });

    console.log('✅ sendMessage terminó correctamente');
    console.log('Resultado:', result);
    console.log('============================\n');

    res.json({ success: true });
  } catch (err) {
    console.log('\n❌ ERROR EN /send');
    console.error(err);

    logger.error({ err }, 'Error en /send');

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

  // Sacar gente del grupo (CaDI tiene que ser admin del grupo para que esto funcione).
  // participants: array de JIDs o string separado por comas.
  app.post('/group/remove-participant', async (req, res) => {
    try {
      const { groupId, motivo } = req.body;
      if (!groupId) return noHecho(res, 'Esta acción solo funciona dentro de un grupo.');

      let participants = req.body.participants ?? req.body.participant ?? [];
      if (typeof participants === 'string') participants = participants.split(',');
      participants = participants.map((p) => p.trim()).filter(Boolean).map((p) => normalizeJid(toIndividualJid(p)));

      // Red de seguridad: nunca sacar a un admin de CaDI ni a CaDI misma,
      // aunque el modelo se equivoque
      const me = sock.authState.creds.me || {};
      const botUsers = [me.id, me.lid].filter(Boolean).map(jidToNumber);
      const protegidos = participants.filter((p) => ADMIN_JIDS.includes(p) || botUsers.includes(jidToNumber(p)));
      participants = participants.filter((p) => !protegidos.includes(p));

      if (participants.length === 0) {
        return noHecho(
          res,
          protegidos.length
            ? 'La persona es administradora del grupo (o es CaDI) y no se la puede sacar.'
            : 'No hay a quién sacar: hay que etiquetar (@) a la persona en el mismo mensaje.'
        );
      }

      console.log('🚪 Sacando del grupo:', participants, '| motivo:', motivo || '(sin motivo)');
      const result = await sock.groupParticipantsUpdate(toGroupJid(groupId), participants, 'remove');
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
  app.post('/group/set-mode', async (req, res) => {
    try {
      const { groupId, mode } = req.body;
      if (!groupId) return noHecho(res, 'Esta acción solo funciona dentro de un grupo.');
      if (!['announcement', 'not_announcement'].includes(mode)) {
        return noHecho(res, "modo inválido: tiene que ser 'announcement' o 'not_announcement'.");
      }
      await sock.groupSettingUpdate(toGroupJid(groupId), mode);
      hecho(res, mode === 'announcement' ? 'ahora solo los admins pueden escribir.' : 'ahora todos pueden escribir.');
    } catch (err) {
      logger.error({ err }, 'Error en /group/set-mode');
      noHecho(res, `error interno (¿CaDI es admin del grupo?): ${err.message}`);
    }
  });

  // Encuesta
  app.post('/group/poll', async (req, res) => {
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
      await sock.sendMessage(toGroupJid(groupId), {
        poll: { name: question, values: options, selectableCount: Number(selectableCount) || 1 },
      });
      hecho(res, `se envió la encuesta con ${options.length} opciones.`);
    } catch (err) {
      logger.error({ err }, 'Error en /group/poll');
      noHecho(res, `error interno: ${err.message}`);
    }
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Solo localhost: los endpoints de admin no quedan expuestos a la red.
  // Escuchamos en las dos direcciones locales porque, en Windows, "localhost"
  // suele resolverse a IPv6 (::1) y no a IPv4 (127.0.0.1).
  app.listen(BRIDGE_PORT, '127.0.0.1', () => {
    logger.info(`Bridge escuchando en http://localhost:${BRIDGE_PORT}`);
  });
  const ipv6 = app.listen(BRIDGE_PORT, '::1');
  ipv6.on('error', (err) => {
    // Si la compu no tiene IPv6, alcanza con 127.0.0.1
    logger.warn({ code: err.code }, 'No se pudo escuchar en ::1 (IPv6); se sigue solo con 127.0.0.1');
  });
}

startBridge();
