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

      const payload = {
        isGroup,
        groupId: isGroup ? remoteJid : null,
        from: senderJid,
        senderJid,
        text,
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

    const { to, text } = req.body;

    console.log('TO recibido:', to);
    console.log('TEXT recibido:', text);

    const jid = to.includes('@g.us')
      ? toGroupJid(to)
      : toIndividualJid(to);

    console.log('JID final:', jid);
    console.log('Intentando enviar...');

    const result = await sock.sendMessage(jid, { text });

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

  // Sacar a alguien del grupo (CaDI tiene que ser admin del grupo para que esto funcione)
  app.post('/group/remove-participant', async (req, res) => {
    try {
      const { groupId, participant } = req.body;
      const result = await sock.groupParticipantsUpdate(
        toGroupJid(groupId),
        [toIndividualJid(participant)],
        'remove'
      );
      res.json({ success: true, result });
    } catch (err) {
      logger.error({ err }, 'Error en /group/remove-participant');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Modo "solo admins pueden escribir" (mode: "announcement" | "not_announcement")
  app.post('/group/set-mode', async (req, res) => {
    try {
      const { groupId, mode } = req.body;
      if (!['announcement', 'not_announcement'].includes(mode)) {
        return res.status(400).json({ success: false, error: 'mode inválido' });
      }
      await sock.groupSettingUpdate(toGroupJid(groupId), mode);
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error en /group/set-mode');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Encuesta
  app.post('/group/poll', async (req, res) => {
    try {
      const { groupId, question, options, selectableCount = 1 } = req.body;
      await sock.sendMessage(toGroupJid(groupId), {
        poll: { name: question, values: options, selectableCount },
      });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error en /group/poll');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.listen(BRIDGE_PORT, () => {
    logger.info(`Bridge escuchando en http://localhost:${BRIDGE_PORT}`);
  });
}

startBridge();
