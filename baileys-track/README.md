# CaDI — Baileys Bridge

Puente entre WhatsApp (protocolo no oficial, vía Baileys) y n8n. No reemplaza
a n8n: n8n sigue siendo el cerebro (Groq con el modelo `openai/gpt-oss-120b`,
Tavily, personalidad de CaDI). Este
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

Importá [`workflow.json`](./workflow.json) en n8n. La cadena es:

```
Webhook1 (/webhook/cadi-grupo) → If (hay texto) → AI Agent → HTTP Request1 (/send)
                                                    ├─ Groq Chat Model (openai/gpt-oss-120b)
                                                    └─ Buscar en internet (Tavily)
```

- **Webhook1** recibe el POST que hace este bridge en `/webhook/cadi-grupo`
  (o el path que hayas puesto en `N8N_WEBHOOK_URL` del `.env`). n8n envuelve
  el JSON bajo `body`, así que los campos se leen como `$json.body.text`.
- **AI Agent** tiene la personalidad de CaDI en su *System Message* y decide
  solo si hace falta buscar en internet. **Buscar en internet** es Tavily
  envuelto como herramienta: su *Tool Description* le dice al modelo cuándo
  usarla, y la consulta (`query`) la arma el propio modelo con `$fromAI()`.
  Así CaDI solo busca cuando la pregunta necesita datos actuales.
- **HTTP Request1** manda la respuesta (`$('AI Agent').item.json.output`)
  a `http://localhost:3001/send`.

Después de importar, cargá tu API key de Tavily en el nodo **Buscar en
internet**, tu número de admin en el prompt del **AI Agent**, y elegí la
credencial de Groq en **Groq Chat Model**.

El payload que manda este bridge tiene esta forma (`from` es el JID completo
del remitente; dentro de grupos puede llegar como `...@lid` en vez de
`...@s.whatsapp.net`):

```json
{
  "isGroup": true,
  "groupId": "120363...@g.us",
  "from": "549XXXXXXXXXX@s.whatsapp.net",
  "senderJid": "549XXXXXXXXXX@s.whatsapp.net",
  "text": "Hola CaDI",
  "messageId": "...",
  "timestamp": 1234567890,
  "pushName": "Matías"
}
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
