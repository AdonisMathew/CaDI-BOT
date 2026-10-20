// CaDI - Importar un chat exportado de WhatsApp a la memoria
//
// Sirve UNA sola vez, para que CaDI pueda buscar lo que se habló ANTES de que entrara al
// grupo. Lo que pasa después ya lo guarda el bridge solo, en vivo.
//
// 1. En el teléfono: abrí el grupo → ⋮ → Más → Exportar chat → "Sin archivos" → guardá el .txt
//    (si viene en un .zip, descomprimilo: adentro está el .txt)
// 2. En esta carpeta (baileys-track), con el bridge corriendo o no:
//
//      node importar-chat.js "C:\ruta\Chat de WhatsApp con Mi Grupo.txt" --grupo "Mi Grupo"
//
//    --grupo busca el id del grupo por nombre (necesita el bridge corriendo).
//    Si preferís pasarlo a mano: --chat 120363XXXXXXXXXXXX@g.us  (lo ves en http://localhost:3001/grupos)
//    --prueba  muestra qué se importaría, sin guardar nada.
//
// Se puede correr dos veces con el mismo archivo: no duplica mensajes. Y saltea lo que el
// bridge ya vio en vivo, para que nada quede repetido.

import 'dotenv/config';
import fs from 'node:fs';
import { abrirMemoria, fechaHoraLarga, localASeg } from './memoria.js';

// ---------- Argumentos ----------
const args = process.argv.slice(2);
const opcion = (nombre) => {
  const i = args.indexOf(nombre);
  return i >= 0 ? args[i + 1] : undefined;
};
const archivo = args.find((a, i) => !a.startsWith('--') && !['--chat', '--grupo', '--formato'].includes(args[i - 1]));
const chatArg = opcion('--chat');
const grupoArg = opcion('--grupo');
const formatoArg = opcion('--formato'); // "dmy" (por defecto en español) o "mdy"
const prueba = args.includes('--prueba');

if (!archivo || (!chatArg && !grupoArg)) {
  console.log(`Uso:
  node importar-chat.js "<archivo .txt exportado>" --grupo "<nombre del grupo>"
  node importar-chat.js "<archivo .txt exportado>" --chat 120363XXXXXXXXXXXX@g.us
Opciones: --prueba (no guarda nada)   --formato mdy (si las fechas vienen mes/día)`);
  process.exit(1);
}

// ---------- Lectura y parseo ----------

// Una línea que empieza un mensaje. Cubre Android e iPhone, con o sin coma, segundos y "p. m.":
//   19/10/26, 20:22 - Juan: hola
//   19/10/2026 8:22 p. m. - Juan: hola
//   [19/10/26, 20:22:13] Juan: hola
const INICIO =
  /^\[?(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s*m\.?)?\]?\s*(?:-\s*)?(.*)$/i;

// Reemplazos de lo que WhatsApp escribe en vez de los archivos
const MULTIMEDIA = [
  [/^<?(multimedia omitido|media omitted)>?$/i, '[multimedia]'],
  [/^<?(imagen omitida|image omitted)>?$/i, '[foto]'],
  [/^<?(video omitido|video omitted)>?$/i, '[video]'],
  [/^<?(audio omitido|audio omitted)>?$/i, '[audio]'],
  [/^<?(sticker omitido|sticker omitted)>?$/i, '[sticker]'],
  [/^<?(gif omitido|gif omitted)>?$/i, '[gif]'],
  [/^<?(documento omitido|document omitted)>?$/i, '[archivo]'],
  [/^<adjunto: .*>$/i, '[archivo]'],
  [/^<attached: .*>$/i, '[archivo]'],
  [/\(archivo adjunto\)$/i, '[archivo]'],
];
const BORRADO = /^(se eliminó este mensaje|eliminaste este mensaje|this message was deleted|you deleted this message)\.?$/i;
const EDITADO = /\s*<(se editó este mensaje|this message was edited)\.?>\s*$/i;

function limpiarTexto(texto) {
  let t = texto.replace(EDITADO, '').trim();
  for (const [re, reemplazo] of MULTIMEDIA) if (re.test(t)) return reemplazo;
  return t;
}

function parsear(contenido, formato) {
  // Espacios raros de WhatsApp (U+202F antes de "p. m.", U+00A0) y marcas invisibles de dirección
  const lineas = contenido
    .replace(/^\uFEFF/, '')
    .replace(/[\u202F\u00A0]/g, ' ')
    .replace(/[\u200E\u200F\u202A-\u202E]/g, '')
    .split(/\r?\n/);

  const crudos = [];
  for (const linea of lineas) {
    const m = INICIO.exec(linea);
    if (m) crudos.push({ partes: m, texto: m[8] });
    else if (crudos.length) crudos.at(-1).texto += `\n${linea}`; // mensaje de varias líneas
  }

  // ¿Día/mes o mes/día? Si algún primer número pasa de 12, seguro es el día
  let mdy = formato === 'mdy';
  if (!formato) {
    const primeros = crudos.map((c) => +c.partes[1]);
    const segundos = crudos.map((c) => +c.partes[2]);
    mdy = !primeros.some((n) => n > 12) && segundos.some((n) => n > 12);
  }

  const filas = [];
  let sistema = 0;
  let borrados = 0;
  let invalidos = 0;
  for (const { partes, texto } of crudos) {
    const [, a, b, año, h, min, seg, ampm] = partes;
    const dia = mdy ? +b : +a;
    const mes = mdy ? +a : +b;
    let hora = +h;
    if (ampm) {
      const pm = ampm.toLowerCase() === 'p';
      if (pm && hora < 12) hora += 12;
      if (!pm && hora === 12) hora = 0;
    }
    const añoCompleto = año.length === 2 ? 2000 + +año : +año;
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || hora > 23) {
      invalidos++;
      continue;
    }

    // "Nombre: mensaje". Sin los dos puntos es un aviso del sistema ("X se unió", etc.)
    const separador = texto.indexOf(': ');
    if (separador <= 0 || separador > 60) {
      sistema++;
      continue;
    }
    const autor = texto.slice(0, separador).trim();
    const mensaje = limpiarTexto(texto.slice(separador + 2));
    if (!mensaje) continue;
    if (BORRADO.test(mensaje)) {
      borrados++;
      continue;
    }
    filas.push({ autor, texto: mensaje, ts: localASeg(añoCompleto, mes, dia, hora, +min, +(seg ?? 0)) });
  }
  filas.sort((x, y) => x.ts - y.ts);
  return { filas, sistema, borrados, invalidos, mdy };
}

// ---------- Id del grupo ----------

async function idDelGrupo() {
  if (chatArg) return chatArg;
  const puerto = Number(process.env.BRIDGE_PORT) || 3001;
  let grupos;
  try {
    const r = await fetch(`http://127.0.0.1:${puerto}/grupos`, { signal: AbortSignal.timeout(20000) });
    grupos = await r.json();
  } catch {
    console.error(`❌ No pude preguntarle al bridge (http://localhost:${puerto}/grupos). ¿Está corriendo? Si no, usá --chat con el id del grupo.`);
    process.exit(1);
  }
  if (!Array.isArray(grupos)) {
    console.error('❌ El bridge no devolvió la lista de grupos (¿WhatsApp conectado?).', grupos);
    process.exit(1);
  }
  const buscado = grupoArg.toLowerCase();
  const coincidencias = grupos.filter((g) => String(g.nombre || '').toLowerCase().includes(buscado));
  if (coincidencias.length !== 1) {
    console.error(
      coincidencias.length
        ? `❌ Hay ${coincidencias.length} grupos que coinciden con "${grupoArg}". Usá --chat con uno de estos ids:`
        : `❌ CaDI no está en ningún grupo que se llame "${grupoArg}". Grupos disponibles:`
    );
    for (const g of coincidencias.length ? coincidencias : grupos) console.error(`   ${g.id}  ${g.nombre}`);
    process.exit(1);
  }
  return coincidencias[0].id;
}

// ---------- Main ----------

if (!fs.existsSync(archivo)) {
  console.error(`❌ No existe el archivo: ${archivo}`);
  process.exit(1);
}
const { filas, sistema, borrados, invalidos, mdy } = parsear(fs.readFileSync(archivo, 'utf8'), formatoArg);
if (!filas.length) {
  console.error('❌ No encontré mensajes en el archivo. ¿Es el .txt exportado de WhatsApp?');
  process.exit(1);
}

const chat = await idDelGrupo();
const autores = [...new Set(filas.map((f) => f.autor))];
console.log(`📄 ${filas.length} mensajes de ${autores.length} personas (${mdy ? 'mes/día' : 'día/mes'})`);
console.log(`   desde ${fechaHoraLarga(filas[0].ts)} hasta ${fechaHoraLarga(filas.at(-1).ts)}`);
console.log(`   se ignoran ${sistema} avisos del sistema y ${borrados} mensajes borrados${invalidos ? ` (y ${invalidos} líneas con fecha inválida: ¿probaste --formato mdy?)` : ''}`);
console.log(`   chat de destino: ${chat}`);

if (prueba) {
  console.log('\nPrimeros mensajes (modo --prueba, no se guarda nada):');
  for (const f of filas.slice(0, 5)) console.log(`   [${fechaHoraLarga(f.ts)}] ${f.autor}: ${f.texto.slice(0, 80)}`);
  process.exit(0);
}

const memoria = abrirMemoria({ logger: { info() {}, warn: console.warn, error: console.error } });
if (!memoria.activa) {
  console.error(`❌ La memoria está apagada: ${memoria.motivo}`);
  process.exit(1);
}
const { insertados, salteados } = memoria.importar(chat, filas);
memoria.cerrar();
console.log(`\n✅ Importados ${insertados} mensajes. Salteados ${salteados} (ya estaban, o el bridge ya los había visto en vivo).`);
