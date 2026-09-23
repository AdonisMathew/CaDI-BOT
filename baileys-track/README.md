# CaDI — Baileys Bridge

Puente entre WhatsApp (protocolo no oficial, vía Baileys) y n8n. No reemplaza
a n8n: n8n sigue siendo el cerebro (Groq, Tavily, personalidad de CaDI). Este
script solo recibe y manda mensajes crudos de WhatsApp.

⚠️ Usa un protocolo no oficial. Viola los Términos de Servicio de WhatsApp y
el número puede ser baneado sin aviso. Usar solo con un número descartable,
nunca con tu número personal ni con el chip de Cloud API que ya tenés andando.

## 1. Instalar dependencias

```bash
npm install
```

(Ya viene con `baileys@6.7.23`, fijado a propósito — es la última versión
**estable** y parcheada contra una vulnerabilidad de spoofing de mensajes que
tiene la 6.17.x. No actualizar a esa por las dudas.)

## 2. Configurar

```bash
cp .env.example .env
```

Dejá `USE_PAIRING_CODE=false` para el método más simple (QR). No hace falta
tocar nada más para arrancar.

## 3. Preparar el número nuevo (cuando tengas el chip)

1. Metés el chip nuevo en un teléfono (temporalmente, puede ser el tuyo).
2. Instalás **WhatsApp Business** (app gratuita normal — no confundir con
   Cloud API) como segunda app, al lado de tu WhatsApp personal.
3. Lo registrás con el número nuevo (código por SMS).
4. Dejalo ahí abierto, listo para escanear un QR en el paso siguiente.

## 4. Levantar el bridge

```bash
npm start
```

Va a aparecer un QR en la terminal. Desde WhatsApp Business (la app que
instalaste en el paso anterior): **Configuración → Dispositivos vinculados
→ Vincular un dispositivo**, y escaneá ese QR.

Si conecta bien, vas a ver en la terminal:
```
✅ Conectado a WhatsApp. CaDI está en línea.
```

Las credenciales quedan guardadas en la carpeta `auth_info_baileys/` — no
hace falta volver a escanear el QR en los próximos arranques, salvo que
borres esa carpeta o cierres la sesión desde el teléfono.

Después de este paso, ya podés volver a poner tu SIM personal en el
teléfono — el chip nuevo no necesita seguir insertado físicamente.

## 5. Conectar con n8n

En n8n, armá (o adaptá) un workflow con:

- Un **Webhook** nuevo en el path `/webhook/cadi-grupo` (o el que hayas
  puesto en `N8N_WEBHOOK_URL` del `.env`) — este bridge le va a hacer POST
  ahí cada vez que llegue un mensaje real.
- El resto de la cadena (`If → IF Admin → HTTP Request Tavily → Message a
  model`) se puede reutilizar del workflow que ya tenés — el payload que
  manda este bridge tiene esta forma:

```json
{
  "isGroup": true,
  "groupId": "120363...@g.us",
  "from": "549XXXXXXXXXX",
  "senderJid": "549XXXXXXXXXX@s.whatsapp.net",
  "text": "Hola CaDI",
  "messageId": "...",
  "timestamp": 1234567890,
  "pushName": "Matías"
}
```

  Ajustá el nodo **IF Admin** para comparar contra `from` en vez del campo
  `entry[0].changes[0].value.messages[0].from` de Meta.

- El nodo final, en vez de pegarle a la Graph API de Meta, hace un
  **HTTP Request POST** a `http://localhost:3001/send` con body:

```json
{ "to": "{{ $json.groupId || $json.from }}", "text": "la respuesta de CaDI" }
```

## Endpoints disponibles

| Endpoint | Body | Qué hace |
|---|---|---|
| `POST /send` | `{ to, text }` | Manda un mensaje (a un grupo o a un individuo) |
| `POST /group/remove-participant` | `{ groupId, participant }` | Saca a alguien del grupo (CaDI debe ser admin) |
| `POST /group/set-mode` | `{ groupId, mode }` | `mode: "announcement"` (solo admins escriben) o `"not_announcement"` |
| `POST /group/poll` | `{ groupId, question, options, selectableCount }` | Manda una encuesta |
| `GET /health` | — | Chequeo de que el bridge está vivo |

## Recordatorios importantes

- **CaDI tiene que ser admin del grupo** para que `remove-participant` y
  `set-mode` funcionen — lo promovés vos manualmente desde la app, una vez
  que el número ya esté agregado como miembro normal.
- No respondas a cada mensaje del grupo automáticamente (mejor solo a
  menciones o comandos) — reduce el patrón de comportamiento "robótico" que
  más dispara detección de baneo.
- Si te desloguean (`connection: close` con `loggedOut`), hay que borrar
  `auth_info_baileys/` y volver a escanear el QR desde cero.
