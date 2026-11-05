# Aprendizajes y problemas resueltos

Registro honesto de los problemas encontrados durante el desarrollo, cómo
se diagnosticaron y cómo se resolvieron. Se deja documentado porque el
proceso de debugging es tan parte del proyecto como el resultado final.

## Track 1 — Cloud API / Meta / n8n

**Mensajes que no llegaban al webhook, sin error visible**
Síntoma: el mensaje figuraba como "entregado" en WhatsApp, pero no
generaba ninguna ejecución en n8n — silencio total, sin logs ni errores.
Causa: la WABA no estaba suscripta a la app (`subscribed_apps` vacío).
Se confirma con `GET /{WABA_ID}/subscribed_apps` vía Graph API Explorer, y
se soluciona con el mismo endpoint en `POST`. Es un paso fácil de saltear
porque no aparece como obligatorio en ningún lado del flujo guiado de
Meta.

**Mensajes entrantes de números no registrados**
Comprobado empíricamente: los mensajes que *inicia* el usuario (customer-
initiated) no requieren que el número esté precargado en ninguna lista de
destinatarios, incluso con la app en modo Development — solo aplica esa
restricción a mensajes que inicia el negocio primero.

**Restricción de cuenta de Meta Business (#2655121)**
Se resolvió cambiando la URL del Business Profile.

**Dashboard de Meta reorganizado (2026)**
La configuración de webhooks dejó de estar en un menú directo
"WhatsApp → Configuration" y pasó a `Use Cases → Customize → Step 2
Production Setup → Configure Webhooks`.

**Nodos duplicados en n8n tras reimportaciones**
Cada reimportación del workflow generaba copias con nombres incrementados
(`Webhook1 1`, `Webhook2`, etc.), la mayoría quedando desactivadas. Causó
confusión sobre cuál era la cadena realmente activa — se identificó
comparando qué nodos no tenían la etiqueta "(Deactivated)" y coincidían
con los nombres de la arquitectura documentada.

**La URL de ngrok cambia en cada reinicio**
Hay que actualizar el Callback URL en Meta al empezar cada sesión de
trabajo si no se paga un dominio fijo de ngrok.

## Decisión de arquitectura: por qué se pasó a Baileys

La limitación central: un número de la Cloud API no puede ser agregado
como participante de un grupo de WhatsApp ya existente — ni la app en
modo Live ni la Groups API de 2026 lo resuelven para este caso de uso
(grupo ya creado, no uno nuevo vía API). Se evaluaron tres alternativas:

1. Usar un link `wa.me` para que la gente le hable a CaDI 1 a 1 desde el
   grupo (descartada — no es "vivir en el grupo").
2. Groups API oficial de Meta (descartada — requiere cuenta de negocio
   verificada y grupos creados desde cero, no el grupo real existente).
3. Baileys, protocolo no oficial (elegida — con el trade-off de riesgo
   de ban asumido conscientemente, ver `baileys-track/README.md`).

## Track 2 — Baileys

**Vulnerabilidad de seguridad en una versión de la librería**
La versión más reciente al momento de instalar (`6.17.16`) tenía una
vulnerabilidad conocida que permite falsificar el remitente de un
mensaje — relevante porque el proyecto depende de verificar el remitente
para el chequeo de administrador. Se fijó la versión en `6.7.23`
(estable y parcheada) en vez de instalar la última disponible sin
chequear.

**Registro del número sin depender de un segundo teléfono físico**
WhatsApp Business puede instalarse como segunda app en el mismo
teléfono que ya tiene WhatsApp personal (números distintos, apps
distintas, sin conflicto). Permite usar el propio celular para el
registro inicial del número nuevo, insertando la SIM solo durante esos
minutos.

**El remitente ya no llega como número de teléfono (`@lid`)**
Síntoma: el nodo IF Admin nunca reconocía al administrador. El campo
`from` traía un número largo que no era el teléfono de nadie.
Causa: WhatsApp identifica cada vez más a las personas con un *Linked ID*
(`123456789012345@lid`) en lugar de `549...@s.whatsapp.net`, sobre todo
en grupos y por privacidad. En Baileys `6.7.23` no hay una forma confiable
de traducir un `@lid` al número real.
Solución: no traducirlo. Se comprobó que el `@lid` de cada persona es el
mismo en el grupo y en privado, así que se usa directamente como
identificador. La lista de admins vive en `ADMIN_JIDS` del `.env` (fuera de
GitHub), y para obtener cada valor alcanza con mirar el `senderJid:` que
imprime el bridge.

**Expresiones de n8n sin `{{ }}`: se comparan como texto literal**
Síntoma: las condiciones del IF Admin daban siempre `false`, por más que
el número fuera el correcto.
Causa: la condición estaba escrita como `=$('Webhook1').item.json...`,
sin llaves. Sin `{{ }}`, n8n no evalúa nada: compara el *texto*
`"$('Webhook1')..."` contra el número. Además, las dos salidas del IF iban
al mismo nodo, así que el nodo no decidía nada.
Regla: en un campo en modo expresión, todo lo que se quiere evaluar va
entre `{{ }}`. Lo que queda afuera es texto fijo.

**El nodo Webhook de n8n envuelve el JSON bajo `body`**
El payload del bridge (`text`, `from`, etc.) se lee como
`$json.body.text`, no `$json.text`. Varias expresiones daban `undefined` en
silencio: el modelo recibía el mensaje vacío y solo los resultados de la
búsqueda, y por eso respondía mezclando la personalidad con información
que nadie había pedido.

**Búsqueda web en cada mensaje**
Síntoma: CaDI buscaba en internet hasta para responder un "hola".
Causa: la cadena era lineal (IF Admin → Tavily → modelo), así que la
búsqueda corría siempre.
Solución: pasar a un nodo **AI Agent** con Tavily conectado como
*herramienta* (HTTP Request Tool). El modelo decide si buscar, guiado por
la *Tool Description*, y arma la consulta con `$fromAI()`. Un saludo ya no
dispara ninguna búsqueda; una pregunta por el clima, sí.

**Markdown en WhatsApp**
`openai/gpt-oss-120b` escribe en Markdown (`**negrita**`), pero WhatsApp
usa un solo asterisco (`*negrita*`), así que se veían asteriscos sueltos.
Se resolvió con una regla de formato en el prompt del sistema.

**CaDI respondía todos los mensajes del grupo**
El bridge reenviaba a n8n cualquier mensaje. Ahora calcula
`addressedToBot`: en grupos solo vale `true` si la etiquetan con @ (se
compara tanto su número como su `@lid`), si responden a un mensaje suyo o
si la nombran. Para el nombre se usa un límite de palabra (`\bCaDI\b`),
así "cadista" no la activa. En privado siempre responde.

**Los permisos los decide el sistema, no el modelo**
Al principio el nivel de acceso era una etiqueta dentro del prompt, y el
modelo "decidía" si obedecer. Para charlar alcanza, pero no para acciones
reales: un modelo se puede convencer con un "soy Adonis desde otro número".
Diseño final, en capas:
1. El bridge marca `isAdmin` según `ADMIN_JIDS`.
2. Un IF en n8n manda a los admins a un agente con herramientas de
   administración, y al resto a otro agente que no las tiene. Aunque
   alguien engañe al modelo, no hay con qué ejecutar la acción.
3. El modelo no elige a quién sacar: se usa la lista de personas
   etiquetadas en el mensaje, que viene de WhatsApp.
4. El bridge nunca saca a un admin ni a CaDI, aunque se lo pidan.
En las pruebas, la capa 4 frenó dos expulsiones de administradores.

**`localhost` en Windows apunta a IPv6**
Síntoma: después de hacer que el bridge escuchara solo en `127.0.0.1`
(para no exponerlo a la red), n8n devolvía *"The service refused the
connection"*.
Causa: en Windows con Node moderno, `localhost` se resuelve primero a `::1`
(IPv6), y el bridge solo atendía IPv4.
Solución: escuchar en las dos direcciones locales, `127.0.0.1` y `::1`.

**El agente decía "listo" aunque la acción hubiera fallado**
Síntoma: al pedirle sacar a un administrador, CaDI respondía que lo había
hecho. Nadie salió del grupo (la protección funcionó), pero la respuesta
era falsa.
Causa: el bridge respondía con errores HTTP (400). n8n trata eso como una
falla del nodo, y el agente probablemente no recibía el motivo, así que
inventaba el resultado.
Solución: los endpoints de grupo responden siempre HTTP 200 con
`success` y un `resultado` explícito (`HECHO: ...` / `NO SE REALIZÓ.
Motivo: ...`), y el prompt prohíbe afirmar una acción sin un `HECHO`
recibido en ese mismo mensaje. Lección general: en un agente, lo que
devuelve una herramienta tiene que ser imposible de malinterpretar.

**Etiquetas que se veían como números**
Para que una etiqueta se muestre con el nombre de la persona, no alcanza
con escribir `@123456` en el texto: el mensaje tiene que incluir también
la lista `mentions` con el JID. Sin eso, WhatsApp muestra el número crudo.
El bridge ahora recuerda los JIDs que ve pasar (remitentes, etiquetados y
admins) y arma `mentions` en `/send` a partir de cada `@número` del texto.

**El workflow exportado de n8n tiene secretos**
Un `workflow.json` exportado desde n8n incluye la API key de Tavily y otros
datos reales. La versión del repo los tiene reemplazados por `XXX`. Antes
de actualizar el repo local hay que revisar `git status`, y si el workflow
aparece modificado, respaldarlo fuera de la carpeta del repo y descartar el
cambio con `git restore`. Nunca commitearlo.

**El bridge "se trababa" después de cualquier microcorte**
Síntoma: CaDI dejaba de contestar de golpe y había que reiniciar el bridge
a mano. Causa: al reconectar, la función de arranque creaba un socket de
WhatsApp nuevo *y* intentaba levantar otro servidor Express en el mismo
puerto. Ese segundo servidor fallaba en silencio (`EADDRINUSE`, que Express
5 le pasa al callback de `listen` en lugar de lanzarlo), así que seguía
atendiendo el primero, cuyas rutas apuntaban al socket **viejo, ya cerrado**.
Resultado: después de la primera reconexión, `/send` intentaba mandar por una
conexión muerta. Se resolvió creando el servidor HTTP una sola vez y haciendo
que siempre use el socket actual, más reconexión con espera creciente,
watchdog y reintentos hacia n8n.

**Ventanas de consola en Windows que congelan procesos**
Si hacés clic dentro de una ventana de PowerShell/CMD con "Edición rápida"
activada, la consola entra en modo selección y **pausa** al proceso que
escribe en ella hasta que apretás Enter o Esc. Con n8n o el bridge corriendo
en esa ventana, parece que "se perdió la conexión". Correr ambos con PM2
(sin ventana) elimina el problema.

## Memoria y herramientas (octubre 2026)

**La memoria no entra "pegando el chat" en el prompt**
Groq gratis permite 8.000 tokens por minuto con `gpt-oss-120b`, y un chat de
meses son cientos de miles. Como CaDI ya está en el grupo, el bridge guarda
cada mensaje en una base SQLite local (`node:sqlite`, incluido en Node 22.13+,
sin dependencias) y le pasa al modelo solo lo útil: los últimos mensajes, las
notas, los resúmenes de días anteriores y, cuando hace falta, una búsqueda en
el historial (FTS5, sin distinguir tildes ni mayúsculas). La exportación del
chat se usa una sola vez, para cargar lo que pasó antes de que CaDI entrara.

**Los tokens cacheados no cuentan para el límite de Groq**
Groq cachea el comienzo de cada pedido en `gpt-oss` y esos tokens no cuentan
para el límite por minuto. Por eso el prompt se partió en dos: la personalidad
y las reglas van fijas en el *system message* (y las definiciones de las
herramientas, que van justo después, también quedan fijas), y todo lo que
cambia — fecha, conversación reciente, notas — va en el mensaje del usuario.
Si la hora estuviera al principio del prompt, cada pedido invalidaría el caché.

**`reasoning_effort` en un modelo que n8n no reconoce**
El nodo de OpenAI de n8n solo muestra "Reasoning Effort" para modelos de OpenAI
(o1, o3, gpt-5). Para `openai/gpt-oss-120b` se pasa igual con *Options → Extra
Body*: `{ "reasoning_effort": "low" }`. Menos razonamiento = menos tokens y
respuestas más rápidas; para que no se equivoque con "el sábado", el contexto
trae la fecha de los próximos 7 días ya calculada.

**n8n le cambia el nombre a las herramientas con tildes**
El modelo ve cada herramienta con el nombre del nodo, pero n8n reemplaza todo
lo que no sea `a-z`, `0-9`, `_` o `-` por `_`: "Enviar ubicación" llegaría como
`Enviar_ubicaci_n`. Por eso el nodo se llama "Enviar ubicacion".

**Una herramienta conectada a dos agentes**
En n8n un mismo nodo de herramienta (o de modelo) se puede conectar a varios
agentes. Las herramientas comunes quedan en una sola copia; las de admin siguen
conectadas solo al agente de admins, que es la barrera de seguridad real.

**Eventos con una versión de Baileys que no los trae**
Baileys 6.7.23 no sabe armar eventos de WhatsApp (los agregó la 7, todavía en
release candidate), pero su `WAProto` sí tiene `EventMessage`. Se arma igual
que en Baileys 7: el mensaje con una `messageSecret` de 32 bytes (con la que
WhatsApp cifra las confirmaciones de asistencia) y `relayMessage` con el
atributo `type: event` y el nodo `<meta event_type="creation">`.

**El `@all` nativo de WhatsApp (agosto 2026)**
WhatsApp agregó su propia mención a todos (`contextInfo.nonJidMentions`), pero
ese campo no existe en el `WAProto` de Baileys 6.7.23, así que no se puede
detectar ni mandar. CaDI etiqueta a todos a la vieja usanza: la lista de
integrantes del grupo en `mentions`, sin escribir los @ en el texto.

**Probar n8n de verdad sin gastar cuota**
Para validar el workflow se levantó un n8n 2.43 local con un "Groq" simulado
(un servidor compatible con la API de OpenAI que decide qué herramienta llamar)
y el bridge real con un WhatsApp simulado que usa las funciones de Baileys para
armar los mensajes. Así se probó la cadena completa — mensaje, contexto,
agente, herramienta, respuesta — incluido el modelo de respaldo ante un 429.

**"Online" en PM2 no quiere decir conectado a WhatsApp**
Después de 13 días sin correr el bridge, la sesión de CaDI apareció
desvinculada: cada arranque terminaba con `statusCode: 401` ("Sesión
desvinculada") y el bridge dejaba de reintentar, a propósito. PM2 lo seguía
mostrando `online` porque el proceso estaba vivo, pero no entraba ningún
mensaje. Se resolvió borrando `auth_info_baileys/` y volviendo a escanear el QR.
El síntoma que lo delató sin abrir los logs: la memoria (`data/cadi.db`) no
había guardado ni un mensaje.

**`pm2 resurrect` levanta lo último guardado con `pm2 save`**
Después de cambiar `ecosystem.config.cjs`, n8n volvió a arrancar con la
configuración vieja porque `resurrect` restaura la lista de procesos (con sus
variables de entorno) tal como estaba en el último `pm2 save`. Cada cambio de
configuración: `pm2 delete all`, `pm2 start ecosystem.config.cjs`, `pm2 save`.

**Importar el historial: dos años en un minuto**
El chat exportado del grupo (129.417 mensajes, desde junio de 2024) se importó
de una vez con `importar-chat.js`: 125.342 guardados. Los salteados son los
que el bridge ya había visto en vivo y los mensajes idénticos de la misma
persona en el mismo minuto (por ejemplo, varias fotos seguidas), porque el
export de Android no trae segundos. La búsqueda sigue siendo instantánea
gracias al índice FTS5.

