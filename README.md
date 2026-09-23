# CaDI 🤖

Un bot/asistente de WhatsApp con personalidad inspirada en **GLaDOS** (Portal),
pensado para vivir dentro de un grupo de amigos: sarcasmo elegante, formalidad
excesiva, estadísticas absurdas inventadas, amenazas cómicas falsas — con
información útil real de fondo (búsqueda web en tiempo real).

Proyecto personal/académico de [Matías Amarilla](https://github.com/AdonisMathew),
estudiante de la Tecnicatura Universitaria en Programación (UTN FRT, Tucumán,
Argentina), construido enteramente con herramientas de capa gratuita.

## La historia corta

Este repo documenta **dos intentos de arquitectura**, no uno solo — y el
motivo por el que existe el segundo es en sí mismo la parte más interesante
del proyecto.

La primera versión se construyó sobre la **WhatsApp Business Cloud API**
oficial de Meta, orquestada con n8n. Funciona perfecto: responde, distingue
administradores de no-administradores, busca información actualizada en la
web. El problema apareció recién al final: **la Cloud API no permite que un
bot sea agregado como participante de un grupo de WhatsApp ya existente** —
una limitación de diseño de la plataforma, no un bug ni algo que se rompió.
Ni siquiera la Groups API que Meta lanzó en 2026 lo resuelve, porque exige
una cuenta de negocio verificada y solo sirve para grupos creados desde cero
vía API, no para meterse en uno que ya existe.

Como el objetivo del proyecto siempre fue que CaDI viva *adentro* del grupo
real, no al lado — la segunda versión reconstruye la capa de mensajería con
**Baileys**, una librería que implementa el protocolo de WhatsApp Web de
forma no oficial, permitiendo que el bot sea un participante real del grupo
con todos los permisos que eso implica (más info y advertencias sobre esto
en [`baileys-track/README.md`](./baileys-track/README.md)).

## Estructura del repo

```
CaDI/
├── cloud-api-track/     → Versión 1: WhatsApp Business Cloud API + n8n (operativa, 1 a 1)
├── baileys-track/       → Versión 2: Baileys + n8n (en construcción, para uso en grupo)
└── docs/
    └── LEARNINGS.md      → Problemas encontrados y cómo se resolvieron, de ambos tracks
```

## Stack técnico

- **Orquestación**: [n8n](https://n8n.io/) (self-hosted)
- **Modelo de lenguaje**: Groq API — LLaMA 3.3 70B Versatile
- **Búsqueda web en tiempo real**: Tavily API
- **Track 1**: WhatsApp Business Cloud API (Meta) + ngrok
- **Track 2**: [Baileys](https://baileys.wiki/) + Express

## Estado actual

| Track | Estado |
|---|---|
| Cloud API | ✅ Operativo — responde 1 a 1, distingue admin/no-admin, con búsqueda web |
| Baileys | 🚧 Código base listo, pendiente de vinculación con un número dedicado |

### Funcionalidades

**Implementadas**
- Recepción y procesamiento de mensajes de WhatsApp
- Respuestas generadas por IA con personalidad GLaDOS
- System prompt configurable
- Búsqueda web en tiempo real (Tavily)
- Filtro de eventos de status
- Webhook verificado y activo con Meta Cloud API
- Filtro de permisos por número (admin vs. usuario regular)

**Pendientes**
- Intervenciones autónomas de CaDI sin ser mencionada (Schedule Trigger)
- Integración en un grupo real de WhatsApp (en desarrollo — track Baileys)

## Nota honesta sobre el track de Baileys

Baileys usa un protocolo no oficial — no es la vía que WhatsApp/Meta
sanciona para este tipo de uso, y el número que se use corre riesgo real de
ser suspendido. Se documenta acá de forma transparente, como parte del
proceso de evaluar trade-offs de ingeniería (cumplimiento vs. funcionalidad),
no como una recomendación de uso en producción o a gran escala.
