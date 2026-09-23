# Track 1 — WhatsApp Business Cloud API

Implementación oficial del bot, usando la Cloud API de Meta orquestada con
n8n. Funciona de punta a punta para conversaciones 1 a 1.

## Arquitectura

```
WhatsApp (usuario) → Meta Cloud API → Webhook (n8n) → IF (filtra texto)
   → IF Admin (verifica remitente) → HTTP Request (Tavily)
   → Message a model (Groq / LLaMA 3.3 70B) → Send message (Cloud API)
```

- El rol de administrador se pasa como metadata oculta al final del prompt
  que recibe el modelo, para que CaDI ajuste el tono/permisos de su
  respuesta según quién le escribe.
- El campo `from` que manda Meta llega sin el `+` — hay que tenerlo en
  cuenta al armar el número de respuesta.

## Setup (valores propios, no incluidos acá)

1. Crear una app en [Meta for Developers](https://developers.facebook.com/)
   con el caso de uso "Connect with customers through WhatsApp".
2. Registrar un número de teléfono en la Cloud API.
3. En n8n, armar el workflow: Webhook → IF → IF Admin → HTTP Request
   (Tavily) → Message a model (Groq, base URL
   `https://api.groq.com/openai/v1`) → Send message.
4. Exponer el webhook local con `ngrok http 5678` y cargar esa URL como
   Callback URL en Meta (`Use Cases → Customize → Step 2 Production Setup
   → Configure Webhooks`).
5. Suscribir la WABA a la app: `POST /{WABA_ID}/subscribed_apps` — paso
   fácil de saltear y causa silenciosa de que no lleguen mensajes (ver
   [`../docs/LEARNINGS.md`](../docs/LEARNINGS.md)).

Variables que cada quien debe completar con las propias (no se incluyen
valores reales en este repo):

| Variable | Dónde se usa |
|---|---|
| `PHONE_NUMBER_ID` | Nodo Send message, endpoint de la Graph API |
| `WABA_ID` | Suscripción de webhooks |
| `VERIFY_TOKEN` | Verificación del Callback URL en Meta |
| `GROQ_API_KEY` | Credencial del nodo OpenAI (apuntando a Groq) en n8n |
| `TAVILY_API_KEY` | Nodo HTTP Request a Tavily |

## Workflow de n8n

[`workflow.json`](./workflow.json) — export real del workflow (`···` →
`Download` en n8n), ya sanitizado: se reemplazaron el Phone Number ID, el
número de administrador y **la API key de Tavily** (estaba hardcodeada
directo en el nodo HTTP Request, no en el sistema de credenciales de n8n)
por placeholders.

**Al importar este workflow en tu propia instancia de n8n vas a tener
que:**
1. Volver a pegar tu propia API key de Tavily en el nodo `HTTP Request`
   (parámetro `api_key`, actualmente dice `YOUR_TAVILY_API_KEY`).
2. Reemplazar `YOUR_PHONE_NUMBER_ID` en el nodo `Send message` por tu
   Phone Number ID real.
3. Reemplazar `549XXXXXXXXXX` (aparece en el nodo `IF Admin` y en el
   prompt del nodo `Message a model`) por tu número real de administrador.
4. Volver a vincular las credenciales de OpenAI (Groq) y WhatsApp en n8n
   — el export incluye las referencias por nombre, pero no los secretos
   en sí.

El prompt de personalidad completo, sin la parte técnica del workflow,
también está disponible por separado en
[`personality-prompt.md`](./personality-prompt.md).

## Limitación conocida

Este track no puede sumarse a un grupo de WhatsApp ya existente como
participante — es la razón por la que existe el [track de Baileys](../baileys-track/).
