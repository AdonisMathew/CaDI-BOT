# CaDI — Baileys Bridge

Puente entre WhatsApp (protocolo no oficial, vía Baileys) y n8n. No reemplaza
a n8n: n8n sigue siendo el cerebro (Groq con el modelo `openai/gpt-oss-120b`,
Tavily, personalidad de CaDI). Este script se encarga de todo lo que toca
WhatsApp: recibir y mandar mensajes, ejecutar las acciones (encuestas,
eventos, ubicaciones, imágenes, @todos) y guardar la **memoria** de los chats.

⚠️ Usa un protocolo no oficial. Viola los Términos de Servicio de WhatsApp y
el número puede ser baneado sin aviso. Usar solo con un número descartable,
nunca con tu número personal ni con el chip de Cloud API que ya tenés andando.

## Qué puede hacer CaDI

| Función | Quién | Cómo se pide |
|---|---|---|
| Recordar de qué se está hablando | todos | automático: ve los últimos mensajes del chat |
| Buscar lo que se dijo antes | todos | "CaDI, ¿qué dijo Vale del asado?" |
| Guardar un dato para siempre (nota) | todos | "CaDI, acordate que el cumple de Vale es el 3 de marzo" |
| Etiquetar a todos | todos (con espera de 10 min; los admins no esperan) | escribir `@todos` o `@all`, o "CaDI, avisales a todos que..." |
| Encuestas | todos | "CaDI, armá una encuesta: viernes o sábado" |
| Eventos de WhatsApp (con confirmación de asistencia) | todos | "CaDI, creá un evento para el asado del sábado a las 21" |
| Ubicaciones (pin del mapa) | todos | "CaDI, mandá la ubicación de la Plaza Independencia" |
| Imágenes con IA | todos (con topes diarios) | "CaDI, hacé una imagen de un robot tomando mate" |
| Buscar en internet | todos | "CaDI, ¿cómo está el clima?" (asume Tucumán) |
| Sacar gente, cambiar quién escribe, borrar notas | solo admins (`ADMIN_JIDS`) | "CaDI, sacá a @Juan" |

## 1. Instalar dependencias

Hace falta **Node 22.13 o más nuevo** (la memoria usa `node:sqlite`, que
viene con Node; no hay que instalar ninguna base de datos).

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

Para que CaDI pueda **crear imágenes** (gratis, ~170 por día):

1. Creá una cuenta gratis en [Cloudflare](https://dash.cloudflare.com/sign-up).
2. En el panel: **Workers AI → Use REST API → Create a Workers AI API Token**
   → **Create API Token** → copiá el token.
3. En esa misma página, copiá el **Account ID**.
4. Pegalos en el `.env`: `CF_API_TOKEN=...` y `CF_ACCOUNT_ID=...`.

Sin esto, todo lo demás funciona igual: CaDI solo va a avisar que las
imágenes no están configuradas.

El resto de las opciones del `.env` (memoria, @todos, topes de imágenes)
tienen valores por defecto que andan bien; cada una está explicada en
[`.env.example`](./.env.example).

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
🧠 Memoria activa (data/cadi.db)
✅ Conectado a WhatsApp. CaDI está en línea.
```

Las credenciales quedan guardadas en la carpeta `auth_info_baileys/` — no
hace falta volver a escanear el QR en los próximos arranques, salvo que
borres esa carpeta o cierres la sesión desde el teléfono.

Después de este paso, ya podés volver a poner tu SIM personal en el
teléfono — el chip nuevo no necesita seguir insertado físicamente.

## 5. Conectar con n8n

Hay dos workflows:

- [`workflow.json`](./workflow.json): **BOT WhatsApp - Baileys (AI Agent)**, el que contesta.
- [`workflow-resumen-diario.json`](./workflow-resumen-diario.json): **CaDI - Resumen diario**, opcional (ver 5.2).

### 5.1 Workflow principal

En n8n: **Create workflow → ⋯ → Import from File** → elegí `workflow.json`.
Después:

1. En **Buscar en internet**, reemplazá `XXXXXXXXXXXXXXXXXXXXXXXXX` por tu API key de Tavily (es un solo nodo, lo usan los dos agentes).
2. En **Groq Chat Model** y **Groq Chat Model (respaldo)**, elegí tu credencial de Groq (si importás en la misma instancia de n8n, ya queda elegida sola).
3. Desactivá el workflow viejo y activá este (los dos usan el mismo webhook `cadi-grupo`).

La cadena es:

```
Webhook1 → If (texto y es para CaDI) → Armar contexto → IF Admin ─┬─ true  → AI Agent Admin ─┐
                                                                  └─ false → AI Agent ───────┴→ HTTP Request1 (/send)

Los dos agentes comparten: Groq Chat Model (gpt-oss-120b) + Groq Chat Model (respaldo, gpt-oss-20b)
  Buscar en internet · Crear encuesta · Crear evento · Enviar ubicacion · Crear imagen
  Etiquetar a todos · Buscar en el historial · Guardar nota
Solo AI Agent Admin: Sacar del grupo · Cambiar modo del grupo · Borrar nota
```

- **Webhook1** recibe el POST que hace este bridge en `/webhook/cadi-grupo`
  (o el path que hayas puesto en `N8N_WEBHOOK_URL` del `.env`). n8n envuelve
  el JSON bajo `body`, así que los campos se leen como `$json.body.text`.
- El bridge ya filtra: solo manda a n8n los mensajes dirigidos a CaDI
  (salvo que pongas `REENVIAR_TODO=true` en el `.env`). La memoria no
  necesita que n8n vea todo: el bridge guarda cada mensaje por su cuenta.
- **If** deja pasar solo los mensajes con texto que son para CaDI
  (`addressedToBot`). En grupos, eso es cuando la etiquetan con @, cuando
  responden a un mensaje suyo o cuando la nombran (`BOT_NAME`). En privado,
  siempre.
- **Armar contexto** (nodo Code) arma lo que lee el modelo. Acá está la
  **personalidad** de CaDI (es la única copia: editala acá). Separa dos cosas
  a propósito:
  - `systemPrompt`: personalidad y reglas. **No cambia** entre mensajes,
    porque Groq guarda en caché el comienzo de cada pedido y los tokens
    cacheados **no cuentan** para el límite de 8.000 por minuto.
  - `userPrompt`: todo lo que cambia — fecha y hora de Tucumán, los próximos
    7 días (para que no se equivoque con "el sábado"), integrantes, notas,
    resúmenes, conversación reciente — más el mensaje y los datos de permisos.
- **IF Admin** separa a los admins (`isAdmin`) del resto. Es la barrera de
  seguridad: las herramientas de administración están conectadas **solo** al
  **AI Agent Admin**. El **AI Agent** de usuarios comunes no las tiene, así
  que aunque alguien engañe al modelo, no hay con qué ejecutar la acción.
- Los agentes usan `reasoning_effort: low` (en *Options → Extra Body* del
  modelo): gpt-oss piensa menos, gasta menos tokens y contesta más rápido.
  Si Groq rechaza un pedido por límite, responde el **modelo de respaldo**
  (gpt-oss-20b, que tiene su propio límite por minuto).
- Las herramientas llaman a los endpoints del bridge. El chat (`chatId`),
  el grupo (`groupId`) y las personas a sacar (`mentionedJids`, los
  etiquetados con @) salen del mensaje, no del modelo: CaDI no puede inventar
  a quién sacar ni buscar en el historial de otro chat.
- **HTTP Request1** manda la respuesta del agente (`$json.output`) a
  `http://localhost:3001/send`. En grupos, la respuesta **cita** el mensaje
  que le hicieron a CaDI, para que se entienda a quién le contesta.

El nivel de acceso no lo decide el modelo: el bridge marca `isAdmin` según
`ADMIN_JIDS`, y el prompt solo lee ese dato. Así nadie puede convencer a CaDI
de que es admin escribiéndolo en el chat (ni poniéndoselo de nombre).

**Opcional (recomendado):** para que nadie más pueda mandarle mensajes falsos
al webhook, cargá una clave en `N8N_WEBHOOK_TOKEN` del `.env` y en
**Webhook1 → Authentication → Header Auth** creá una credencial con
**Name** `x-cadi-token` y **Value** la misma clave.

### 5.2 Resumen diario (opcional)

Importá `workflow-resumen-diario.json` igual que el anterior, elegí la
credencial de Groq en **Groq (resúmenes)** y activalo. Todos los días a las
4 de la mañana:

1. Le pide al bridge los días anteriores que todavía no tienen resumen
   (`GET /memoria/pendientes`), partidos en bloques que entran en un pedido.
2. Resume cada bloque con `gpt-oss-20b` (no gasta la cuota del modelo
   principal) y lo guarda (`POST /memoria/resumen`).
3. Espera 1 minuto entre bloques para no pasarse del límite por minuto.

CaDI ve los resúmenes de los últimos 3 días (`RESUMENES_DIAS`), así puede
seguir una charla de ayer sin que nadie se la cuente. Con **Probar ahora**
lo podés correr en el momento, sin esperar a las 4.

## 6. Memoria

El bridge guarda **todos** los mensajes de los chats donde está CaDI (no solo
los que le hablan a ella) en `data/cadi.db`, una base SQLite en tu compu.
Nunca se sube a GitHub (`data/` está en el `.gitignore`).

- **Corto plazo:** con cada mensaje para CaDI viajan los últimos 15 mensajes
  del chat (de hasta 12 horas atrás). Así sabe de qué se está hablando.
- **Mediano plazo:** los resúmenes diarios (5.2).
- **Largo plazo:** las **notas** que el grupo le pide guardar y la herramienta
  **Buscar en el historial** (busca sin importar tildes ni mayúsculas).
- Si alguien **edita** o **borra para todos** un mensaje, la memoria también
  lo cambia o lo borra.
- Quien no quiera que CaDI guarde sus mensajes: su JID en `MEMORIA_EXCLUIR`.
  Para que la memoria se limpie sola, `MEMORIA_DIAS` (por ejemplo, 180).

Conviene avisarle al grupo: lo que CaDI recuerda viaja a Groq (Estados
Unidos) cuando arma una respuesta.

### Cargar el historial de antes de que CaDI entrara

Lo que pasa desde que CaDI está en el grupo ya queda guardado solo. Para lo
anterior, se importa **una sola vez** el chat exportado:

1. En tu teléfono: el grupo → **⋮ → Más → Exportar chat → Sin archivos**.
   Guardá el `.txt` en la compu (si viene en un `.zip`, descomprimilo).
2. Con el bridge corriendo, desde esta carpeta:

   ```bash
   node importar-chat.js "C:\ruta\Chat de WhatsApp con Mi Grupo.txt" --grupo "Mi Grupo" --prueba
   ```

   `--prueba` muestra qué se importaría sin guardar nada. Si se ve bien,
   corré lo mismo sin `--prueba`.

Se puede repetir sin duplicar mensajes, y saltea lo que el bridge ya vio en
vivo. Si los nombres del archivo no coinciden con los de WhatsApp (el
export usa los nombres de tu agenda), la búsqueda por autor usa esos.

## 7. @todos

- Alguien escribe `@todos` (o `@all`) **sin hablarle a CaDI**: el bridge
  responde solo, citando el mensaje, con una frase de CaDI y una etiqueta
  invisible a todos (a cada uno le llega la notificación, sin llenar el chat
  de @). No pasa por n8n ni gasta Groq.
- Alguien le pide a CaDI un aviso con `@todos` o "avisales a todos": CaDI
  escribe el aviso y su respuesta etiqueta a todos.
- Entre dos convocatorias tienen que pasar 10 minutos (`TODOS_ESPERA_MIN`);
  si alguien lo intenta antes, CaDI reacciona con ⏳. Los admins no esperan.

Desde agosto de 2026 WhatsApp tiene su propio `@all` (en grupos de hasta 32
personas cualquiera lo puede usar; en grupos más grandes, solo admins).
Baileys 6.7.23 no reconoce esa mención nativa. Si en el grupo la usan y CaDI
también etiqueta (dos notificaciones), dejá en `PALABRAS_TODOS` solo `@todos`.

## Endpoints disponibles

| Endpoint | Body | Qué hace |
|---|---|---|
| `POST /send` | `{ to, text, quotedId? }` | Manda un mensaje (a un grupo o a una persona). `quotedId` cita ese mensaje. Cada `@número` (o `@Nombre` de un integrante conocido) se manda como etiqueta real |
| `POST /group/remove-participant` | `{ groupId, participants, motivo? }` | Saca gente del grupo (CaDI debe ser admin). Nunca saca a alguien de `ADMIN_JIDS` ni a CaDI |
| `POST /group/set-mode` | `{ groupId, mode }` | `mode: "announcement"` (solo admins escriben) o `"not_announcement"` |
| `POST /group/poll` | `{ chatId \| groupId, question, options }` | Encuesta. `options`: array o string separado por `\|`, entre 2 y 12 |
| `POST /group/event` | `{ groupId, nombre, inicio, fin?, descripcion?, lugar? }` | Evento de WhatsApp. Fechas ISO; sin zona horaria, se asume la de Tucumán |
| `POST /group/mencionar-todos` | `{ groupId, isAdmin }` | La próxima respuesta de CaDI en ese grupo etiqueta a todos |
| `POST /ubicacion` | `{ chatId, consulta }` | Busca el lugar en OpenStreetMap (primero en Tucumán) y manda el pin |
| `POST /imagen` | `{ chatId, prompt, solicitante?, isAdmin? }` | Genera una imagen (Cloudflare o Pollinations) y la manda |
| `POST /memoria/buscar` | `{ chatId, consulta?, desde?, hasta?, autor? }` | Busca en el historial de ese chat |
| `POST /memoria/nota` | `{ chatId, texto, autor? }` | Guarda una nota del chat |
| `POST /memoria/nota/borrar` | `{ chatId, id }` | Borra una nota |
| `GET /memoria/pendientes` | — | Días sin resumir (para el workflow de resúmenes) |
| `POST /memoria/resumen` | `{ chat, fecha, parte?, texto }` | Guarda el resumen de un día |
| `GET /grupos` | — | Grupos donde está CaDI (id y nombre) |
| `GET /health` | — | `200` si WhatsApp está conectado; `503` si no. Incluye el estado de la memoria y de las imágenes |

El bridge escucha solo en tu compu (`127.0.0.1` y `::1`): los endpoints no
quedan expuestos a otras máquinas de tu red.

Las herramientas siempre responden HTTP 200 con `success` (true/false) y un
`resultado` en texto (`HECHO: ...` o `NO SE REALIZÓ. Motivo: ...`). Es a
propósito: si respondieran con un error HTTP, n8n lo trataría como una falla
del nodo y el agente podría no enterarse del motivo, y terminar diciendo que
la acción salió bien.

El payload que manda este bridge a n8n tiene esta forma (`from` es el JID
completo del remitente; dentro de grupos puede llegar como `...@lid`):

```json
{
  "isGroup": true,
  "groupId": "120363...@g.us",
  "chatId": "120363...@g.us",
  "from": "123456789012345@lid",
  "senderJid": "123456789012345@lid",
  "text": "CaDI, ¿quién trae el carbón?",
  "addressedToBot": true,
  "isAdmin": false,
  "mentionedJids": [],
  "messageId": "...",
  "timestamp": 1792450000,
  "pushName": "Vale",
  "etiquetarTodos": false,
  "etiquetarTodosEspera": null,
  "contexto": {
    "grupo": { "nombre": "Mi Grupo", "integrantes": 12 },
    "integrantes": [{ "nombre": "Juan", "mencion": "@123456789012345" }],
    "notas": [{ "id": 3, "texto": "El cumpleaños de Vale es el 3 de marzo" }],
    "resumenes": [{ "fecha": "2026-10-18", "texto": "Organizaron un asado..." }],
    "historial": [{ "cuando": "20:15", "nombre": "Juan", "texto": "El sábado asado en lo de Vale" }]
  }
}
```

## 8. Dejarlo corriendo sin interrupciones (PM2)

[PM2](https://pm2.keymetrics.io/) mantiene al bridge **y** a n8n corriendo en
segundo plano, sin ventanas de PowerShell abiertas, y los vuelve a levantar
solos si se caen. La configuración está en
[`ecosystem.config.cjs`](./ecosystem.config.cjs) (incluye la zona horaria de
Tucumán para n8n y que n8n solo atienda a esta compu).

Una sola vez:

```bash
npm install -g pm2
npm install -g n8n        # si hoy arrancás n8n con "npx n8n", esto lo reemplaza
```

Cada vez que quieras arrancar todo (desde esta carpeta):

```bash
pm2 start ecosystem.config.cjs
```

Comandos útiles:

| Comando | Qué hace |
|---|---|
| `pm2 status` | Muestra si `cadi-bridge` y `n8n` están `online`, cuánta RAM usan y cuántas veces se reiniciaron |
| `pm2 logs cadi-bridge` | Ver los logs del bridge en vivo (Ctrl+C para salir; el bridge sigue corriendo) |
| `pm2 restart cadi-bridge` | Reiniciar el bridge (por ejemplo, después de cambiar el `.env`) |
| `pm2 stop all` | Apagar todo |

> Si es la primera vez y hay que escanear el QR, hacelo con `npm start`
> (en la terminal se ve mejor), cortá con Ctrl+C y recién ahí usá PM2.
> Nunca dejes `npm start` abierto **y** PM2 a la vez: serían dos bridges con
> la misma sesión y WhatsApp los echa a los dos (el bridge lo detecta y frena).

### Qué hace el bridge cuando algo falla

- **Se corta WhatsApp:** reconecta solo, esperando 2s, 4s, 8s... hasta 60s
  entre intentos. Si queda trabado "conectando" más de 2 minutos, un
  vigilante (watchdog) fuerza un intento nuevo.
- **n8n pide responder mientras WhatsApp reconecta:** `/send` espera hasta
  20s a que vuelva la conexión antes de dar error.
- **n8n está caído o arrancando:** el mensaje se reintenta durante ~1 minuto
  (a los 3s, 10s, 20s y 30s) antes de descartarlo.
- **Mensajes viejos tras un corte:** no se contestan los de más de 5 minutos
  (`MAX_ANTIGUEDAD_SEG`), pero sí se guardan en la memoria.
- **Logout o sesión abierta en otro lado:** no reintenta (no tiene sentido);
  `/health` responde `"detenido"` con el motivo.

## Recordatorios importantes

- **CaDI tiene que ser admin del grupo** para que `remove-participant` y
  `set-mode` funcionen — lo promovés vos manualmente desde la app, una vez
  que el número ya esté agregado como miembro normal.
- Para sacar a alguien, el admin tiene que **etiquetarlo con @** en el mismo
  mensaje (por ejemplo: `@CaDI sacá a @Juan`).
- Los **eventos** se arman a mano (Baileys 6.7.23 no los trae), copiando el
  formato de Baileys 7. Probalo primero en el grupo de prueba.
- Si te desloguean (`connection: close` con `loggedOut`), hay que borrar
  `auth_info_baileys/` y volver a escanear el QR desde cero. La memoria
  (`data/`) no se toca.
