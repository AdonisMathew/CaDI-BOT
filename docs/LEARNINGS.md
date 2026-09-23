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
