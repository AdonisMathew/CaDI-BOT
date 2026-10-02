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
