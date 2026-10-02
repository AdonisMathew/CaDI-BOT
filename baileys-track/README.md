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

Dejá `USE_PAIRING_CODE=false` para el método más simple (QR).

Cargá en `ADMIN_JIDS` los identificadores de los administradores de CaDI,
separados por coma. Para obtenerlos, levantá el bridge, mandá un mensaje
desde cada cuenta y copiá lo que aparece en la terminal como `senderJid:`
(suele terminar en `@lid`). Esto vive solo en tu `.env`, que no se sube a
GitHub.

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
Webhook1 → If (texto y es para CaDI) → IF Admin ─┬─ true  → AI Agent Admin ─┐
                                                 └─ false → AI Agent ───────┴→ HTTP Request1 (/send)

AI Agent Admin: Groq Chat Model (Admin) + Buscar en internet (Admin)
                + Sacar del grupo + Cambiar modo del grupo + Crear encuesta
AI Agent:       Groq Chat Model + Buscar en internet
```

- **Webhook1** recibe el POST que hace este bridge en `/webhook/cadi-grupo`
  (o el path que hayas puesto en `N8N_WEBHOOK_URL` del `.env`). n8n envuelve
  el JSON bajo `body`, así que los campos se leen como `$json.body.text`.
- **If** deja pasar solo los mensajes con texto que son para CaDI
  (`addressedToBot`). En grupos, eso es cuando la etiquetan con @, cuando
  responden a un mensaje suyo o cuando la nombran (`BOT_NAME`). En privado,
  siempre.
- **IF Admin** separa a los admins (`isAdmin`) del resto. Es la barrera de
  seguridad: las herramientas de administración están conectadas **solo** al
  **AI Agent Admin**. El **AI Agent** de usuarios comunes no las tiene, así
  que aunque alguien engañe al modelo, no hay con qué ejecutar la acción.
- **AI Agent** y **AI Agent Admin** tienen la personalidad de CaDI en su *System Message* y decide
  solo si hace falta buscar en internet. **Buscar en internet** es Tavily
  envuelto como herramienta: su *Tool Description* le dice al modelo cuándo
  usarla, y la consulta (`query`) la arma el propio modelo con `$fromAI()`.
  Así CaDI solo busca cuando la pregunta necesita datos actuales.
- Las herramientas de admin llaman a los endpoints del bridge. El grupo
  (`groupId`) y las personas a sacar (`mentionedJids`, los etiquetados con @)
  salen del mensaje, no del modelo: CaDI no puede inventar a quién sacar.
- **HTTP Request1** manda la respuesta del agente que haya corrido (`$json.output`)
  a `http://localhost:3001/send`.

Después de importar, cargá tu API key de Tavily en el nodo **Buscar en
internet** y en **Buscar en internet (Admin)**, y elegí la credencial de Groq
en los dos nodos **Groq Chat Model**.

El nivel de acceso no lo decide el modelo: el bridge marca `isAdmin` según
`ADMIN_JIDS`, y el prompt del **AI Agent** solo lee ese dato. Así nadie
puede convencer a CaDI de que es admin escribiéndolo en el chat.

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
  "addressedToBot": true,
  "isAdmin": false,
  "mentionedJids": ["123456789012345@lid"],
  "messageId": "...",
  "timestamp": 1234567890,
  "pushName": "Matías"
}
```

## Endpoints disponibles

| Endpoint | Body | Qué hace |
|---|---|---|
| `POST /send` | `{ to, text }` | Manda un mensaje (a un grupo o a un individuo) |
| `POST /group/remove-participant` | `{ groupId, participants, motivo? }` | Saca gente del grupo (CaDI debe ser admin). `participants`: array o string separado por comas. Nunca saca a alguien de `ADMIN_JIDS` ni a CaDI, y devuelve error si WhatsApp rechaza la acción |
| `POST /group/set-mode` | `{ groupId, mode }` | `mode: "announcement"` (solo admins escriben) o `"not_announcement"` |
| `POST /group/poll` | `{ groupId, question, options, selectableCount }` | Manda una encuesta. `options`: array o string separado por `\|`, entre 2 y 12 |
| `GET /health` | — | Chequeo de que el bridge está vivo |

El bridge escucha solo en `127.0.0.1`: los endpoints no quedan expuestos a
otras máquinas de tu red. Las acciones de grupo devuelven error si se llaman
sin `groupId` (por ejemplo, desde un chat privado).

## Recordatorios importantes

- **CaDI tiene que ser admin del grupo** para que `remove-participant` y
  `set-mode` funcionen — lo promovés vos manualmente desde la app, una vez
  que el número ya esté agregado como miembro normal.
- Para sacar a alguien, el admin tiene que **etiquetarlo con @** en el mismo
  mensaje (por ejemplo: `@CaDI sacá a @Juan`).
- Si te desloguean (`connection: close` con `loggedOut`), hay que borrar
  `auth_info_baileys/` y volver a escanear el QR desde cero.
