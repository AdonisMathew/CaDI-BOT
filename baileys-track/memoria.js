// CaDI - Memoria
// Guarda los mensajes de cada chat en una base SQLite local (data/cadi.db), para que
// CaDI sepa de qué se está hablando y pueda buscar lo que se dijo antes.
//
// Por qué así y no "pegarle el chat exportado al modelo": Groq gratis permite 8.000
// tokens por minuto, y un chat de meses son cientos de miles. Entonces:
//   - corto plazo:  los últimos mensajes del chat viajan en cada pedido a n8n
//   - mediano plazo: un resumen por día (lo genera el workflow "CaDI - Resumen diario")
//   - largo plazo:  notas que el grupo le pide guardar + búsqueda en todo el historial
//
// Usa node:sqlite, que viene incluido en Node 22.13 o más nuevo: no hay que instalar nada.
// Todo queda en tu compu: data/ está en el .gitignore y nunca se sube a GitHub.

import fs from 'node:fs';
import path from 'node:path';

export const ZONA_HORARIA = process.env.ZONA_HORARIA || 'America/Argentina/Tucuman';

// =====================================================================
// 1. Fechas y horas (siempre en la hora de Tucumán, aunque la compu esté en otra zona)
// =====================================================================

const formatoPartes = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONA_HORARIA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

// Devuelve { año, mes, dia, hora, min, seg } de un instante, en la zona horaria del bot
function partes(ms) {
  const p = Object.fromEntries(formatoPartes.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { año: +p.year, mes: +p.month, dia: +p.day, hora: +p.hour, min: +p.minute, seg: +p.second };
}

const dos = (n) => String(n).padStart(2, '0');

export const ahoraSeg = () => Math.floor(Date.now() / 1000);

// "2026-10-19" (fecha local)
export function fechaISO(seg) {
  const p = partes(seg * 1000);
  return `${p.año}-${dos(p.mes)}-${dos(p.dia)}`;
}

// "20:15"
export function horaCorta(seg) {
  const p = partes(seg * 1000);
  return `${dos(p.hora)}:${dos(p.min)}`;
}

// "19/10 20:15"
export function fechaHoraCorta(seg) {
  const p = partes(seg * 1000);
  return `${dos(p.dia)}/${dos(p.mes)} ${dos(p.hora)}:${dos(p.min)}`;
}

// "19/10/2026 20:15"
export function fechaHoraLarga(seg) {
  const p = partes(seg * 1000);
  return `${dos(p.dia)}/${dos(p.mes)}/${p.año} ${dos(p.hora)}:${dos(p.min)}`;
}

// Hora si es de hoy; fecha y hora si es de otro día. Es lo que ve el modelo en la conversación reciente.
export function etiquetaTiempo(seg) {
  return fechaISO(seg) === fechaISO(ahoraSeg()) ? horaCorta(seg) : fechaHoraCorta(seg);
}

// Cuántos minutos le lleva la zona horaria a UTC en ese instante (Tucumán: -180)
function desfaseMin(ms) {
  const p = partes(ms);
  return (Date.UTC(p.año, p.mes - 1, p.dia, p.hora, p.min, p.seg) - ms) / 60000;
}

// Fecha y hora "de reloj" en Tucumán -> segundos Unix
export function localASeg(año, mes, dia, hora = 0, min = 0, seg = 0) {
  const supuesto = Date.UTC(año, mes - 1, dia, hora, min, seg);
  return Math.floor((supuesto - desfaseMin(supuesto) * 60000) / 1000);
}

// Interpreta lo que manda el modelo: "2026-10-24", "2026-10-24 21:00", "2026-10-24T21:00:00-03:00".
// Sin zona horaria, se asume la hora de Tucumán (no la de la compu). Devuelve segundos o null.
// finDelDia: para un "hasta" que es solo una fecha, toma 23:59:59 en vez de 00:00.
export function parsearFecha(texto, { finDelDia = false } = {}) {
  if (texto === undefined || texto === null) return null;
  const t = String(texto).trim();
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(t);
  if (!m) {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  const [, a, me, d, h, mi, s, zona] = m;
  if (zona) {
    const iso = `${a}-${me}-${d}T${dos(h ?? 0)}:${mi ?? '00'}:${s ?? '00'}${zona.toUpperCase() === 'Z' ? 'Z' : zona.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  const conHora = h !== undefined;
  return localASeg(
    +a, +me, +d,
    conHora ? +h : finDelDia ? 23 : 0,
    conHora ? +mi : finDelDia ? 59 : 0,
    conHora ? +(s ?? 0) : finDelDia ? 59 : 0
  );
}

// =====================================================================
// 2. Utilidades de texto
// =====================================================================

export function recortar(texto, max) {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Saca tildes y pasa a minúsculas: "Matías" -> "matias"
export const normalizar = (t) =>
  String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Palabras que no sirven para buscar ("qué dijo Juan del asado" -> "juan asado")
const VACIAS = new Set(
  ('a al algo algun alguna alguno ante antes aqui asi como con cual cuales cuando de del desde donde dijo dijeron ' +
    'el ella ellos en entre era es esa ese eso esta este esto fue hablo hablaron hablamos hay la las le les lo los ' +
    'mas me mi mis muy nada ni no nos o otra otro para pero por porque que quien quienes se sea segun ser si sin ' +
    'sobre su sus tal te tema tiene todo tu tus un una uno unos unas y ya yo vos dicho decir paso pasado charla mensaje mensajes')
    .split(' ')
);

// Arma una consulta FTS5 segura a partir de texto libre. "o" = true usa OR en vez de AND.
function consultaFts(texto, { o = false } = {}) {
  const palabras = [...new Set(normalizar(texto).match(/[a-z0-9]+/g) || [])]
    .filter((p) => (p.length >= 3 || /^\d+$/.test(p)) && !VACIAS.has(p))
    .slice(0, 6);
  if (!palabras.length) return null;
  // "asado"* también encuentra "asados"; las comillas evitan que FTS5 lea operadores raros
  return palabras.map((p) => `"${p}"*`).join(o ? ' OR ' : ' ');
}

// =====================================================================
// 3. Base de datos
// =====================================================================

// node:sqlite todavía figura como "experimental" y Node lo avisa en cada arranque. Ese aviso
// puntual no aporta nada (la API que usamos es estable en la práctica), así que se silencia;
// cualquier otro aviso de Node se sigue mostrando igual.
const emitirAviso = process.emitWarning;
process.emitWarning = function (aviso, ...resto) {
  const texto = typeof aviso === 'string' ? aviso : aviso?.message;
  if (/SQLite is an experimental feature/i.test(texto || '')) return;
  return emitirAviso.call(process, aviso, ...resto);
};

let DatabaseSync = null;
let motivoSinSqlite = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  motivoSinSqlite = `node:sqlite no está disponible en Node ${process.versions.node} (hace falta Node 22.13 o más nuevo)`;
}

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS mensajes (
  id        INTEGER PRIMARY KEY,
  wa_id     TEXT,                       -- id del mensaje en WhatsApp (NULL en los importados)
  chat      TEXT    NOT NULL,           -- JID del grupo o del chat privado
  autor_jid TEXT,                       -- JID de quien lo mandó (NULL en los importados)
  autor     TEXT    NOT NULL,           -- nombre visible en ese momento
  texto     TEXT    NOT NULL,
  ts        INTEGER NOT NULL,           -- fecha y hora, en segundos Unix
  es_bot    INTEGER NOT NULL DEFAULT 0, -- 1 si lo mandó CaDI
  origen    TEXT    NOT NULL DEFAULT 'vivo' -- 'vivo' (lo vio el bridge) o 'export' (importado)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mensajes_wa ON mensajes(chat, wa_id) WHERE wa_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_mensajes_export ON mensajes(chat, ts, autor, texto) WHERE origen = 'export';
CREATE INDEX IF NOT EXISTS ix_mensajes_chat_ts ON mensajes(chat, ts);

-- Índice de búsqueda de texto completo: sin distinguir mayúsculas ni tildes
CREATE VIRTUAL TABLE IF NOT EXISTS mensajes_fts USING fts5(
  texto, autor, content='mensajes', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS mensajes_ai AFTER INSERT ON mensajes BEGIN
  INSERT INTO mensajes_fts(rowid, texto, autor) VALUES (new.id, new.texto, new.autor);
END;
CREATE TRIGGER IF NOT EXISTS mensajes_ad AFTER DELETE ON mensajes BEGIN
  INSERT INTO mensajes_fts(mensajes_fts, rowid, texto, autor) VALUES ('delete', old.id, old.texto, old.autor);
END;
CREATE TRIGGER IF NOT EXISTS mensajes_au AFTER UPDATE OF texto, autor ON mensajes BEGIN
  INSERT INTO mensajes_fts(mensajes_fts, rowid, texto, autor) VALUES ('delete', old.id, old.texto, old.autor);
  INSERT INTO mensajes_fts(rowid, texto, autor) VALUES (new.id, new.texto, new.autor);
END;

CREATE TABLE IF NOT EXISTS notas (
  id    INTEGER PRIMARY KEY,
  chat  TEXT    NOT NULL,
  texto TEXT    NOT NULL,
  autor TEXT,
  ts    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resumenes (
  chat  TEXT    NOT NULL,
  fecha TEXT    NOT NULL,               -- 'YYYY-MM-DD' (hora de Tucumán)
  parte INTEGER NOT NULL DEFAULT 1,     -- los días con mucha charla se resumen en partes
  texto TEXT    NOT NULL,
  ts    INTEGER NOT NULL,
  PRIMARY KEY (chat, fecha, parte)
);

CREATE TABLE IF NOT EXISTS nombres (
  jid    TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  ts     INTEGER NOT NULL
);
`;

// Memoria "apagada": misma interfaz, no guarda nada. Así el resto del bridge no se rompe.
function memoriaApagada(motivo) {
  const nada = () => [];
  return {
    activa: false,
    motivo,
    guardarMensaje: () => false,
    editarMensaje: () => false,
    borrarMensaje: () => false,
    recientes: nada,
    buscar: () => ({ total: 0, texto: 'La memoria de CaDI está apagada.' }),
    guardarNota: () => ({ ok: false, error: 'la memoria de CaDI está apagada' }),
    borrarNota: () => false,
    notas: nada,
    resumenesRecientes: nada,
    pendientesDeResumen: nada,
    guardarResumen: () => false,
    recordarNombre: () => {},
    nombreDe: () => null,
    nombrePorNumero: () => null,
    primerMensajeVivo: () => null,
    importar: () => ({ insertados: 0, salteados: 0 }),
    purgar: () => 0,
    estadisticas: () => ({ activa: false, motivo }),
    cerrar: () => {},
  };
}

/**
 * Abre (o crea) la base de la memoria.
 * @param {object} op
 * @param {string} op.archivo   ruta de la base (por defecto data/cadi.db)
 * @param {object} op.logger    logger con .info/.warn/.error
 */
export function abrirMemoria({ archivo = process.env.MEMORIA_ARCHIVO || 'data/cadi.db', logger = console } = {}) {
  if (process.env.MEMORIA_ACTIVA === 'false') return memoriaApagada('desactivada en el .env (MEMORIA_ACTIVA=false)');
  if (!DatabaseSync) {
    logger.warn(`⚠️  Memoria apagada: ${motivoSinSqlite}.`);
    return memoriaApagada(motivoSinSqlite);
  }

  fs.mkdirSync(path.dirname(path.resolve(archivo)), { recursive: true });
  const db = new DatabaseSync(archivo);
  // WAL: permite leer mientras se escribe (por ejemplo, importar el chat con el bridge andando)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(ESQUEMA);

  const sql = {
    insertar: db.prepare(
      `INSERT OR IGNORE INTO mensajes (wa_id, chat, autor_jid, autor, texto, ts, es_bot, origen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    editar: db.prepare('UPDATE mensajes SET texto = ? WHERE chat = ? AND wa_id = ?'),
    borrar: db.prepare('DELETE FROM mensajes WHERE chat = ? AND wa_id = ?'),
    recientes: db.prepare(
      `SELECT autor, autor_jid, texto, ts, es_bot FROM mensajes
       WHERE chat = ? AND ts >= ? AND (wa_id IS NULL OR wa_id <> ?)
       ORDER BY ts DESC, id DESC LIMIT ?`
    ),
    buscarFts: db.prepare(
      `SELECT m.autor, m.texto, m.ts, m.es_bot FROM mensajes_fts
       JOIN mensajes m ON m.id = mensajes_fts.rowid
       WHERE mensajes_fts MATCH ? AND m.chat = ? AND m.ts BETWEEN ? AND ?
       ORDER BY bm25(mensajes_fts) LIMIT ?`
    ),
    rango: db.prepare(
      `SELECT autor, texto, ts, es_bot FROM mensajes
       WHERE chat = ? AND ts BETWEEN ? AND ?
       ORDER BY ts DESC, id DESC LIMIT ?`
    ),
    insertarNota: db.prepare('INSERT INTO notas (chat, texto, autor, ts) VALUES (?, ?, ?, ?)'),
    borrarNota: db.prepare('DELETE FROM notas WHERE chat = ? AND id = ?'),
    notas: db.prepare('SELECT id, texto, autor, ts FROM notas WHERE chat = ? ORDER BY id'),
    contarNotas: db.prepare('SELECT COUNT(*) AS n FROM notas WHERE chat = ?'),
    resumenes: db.prepare(
      `SELECT fecha, parte, texto FROM resumenes WHERE chat = ? AND fecha < ?
       ORDER BY fecha DESC, parte ASC LIMIT 60`
    ),
    existeResumen: db.prepare('SELECT 1 FROM resumenes WHERE chat = ? AND fecha = ? LIMIT 1'),
    guardarResumen: db.prepare(
      `INSERT INTO resumenes (chat, fecha, parte, texto, ts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat, fecha, parte) DO UPDATE SET texto = excluded.texto, ts = excluded.ts`
    ),
    mensajesVivos: db.prepare(
      `SELECT chat, autor, texto, ts, es_bot FROM mensajes
       WHERE origen = 'vivo' AND ts >= ? AND ts < ? ORDER BY chat, ts, id`
    ),
    guardarNombre: db.prepare(
      `INSERT INTO nombres (jid, nombre, ts) VALUES (?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET nombre = excluded.nombre, ts = excluded.ts`
    ),
    nombres: db.prepare('SELECT jid, nombre FROM nombres'),
    primerVivo: db.prepare(`SELECT MIN(ts) AS ts FROM mensajes WHERE chat = ? AND origen = 'vivo'`),
    purgar: db.prepare('DELETE FROM mensajes WHERE ts < ?'),
    contarMensajes: db.prepare('SELECT COUNT(*) AS n FROM mensajes'),
    contarTodasNotas: db.prepare('SELECT COUNT(*) AS n FROM notas'),
    contarResumenes: db.prepare('SELECT COUNT(*) AS n FROM resumenes'),
  };

  // Nombres en memoria RAM: se consultan en cada mensaje, no vale la pena ir a la base
  const nombres = new Map(); // jid -> nombre
  const nombresPorNumero = new Map(); // "123456..." -> nombre
  const numeroDe = (jid) => String(jid).split('@')[0].split(':')[0];
  for (const fila of sql.nombres.all()) {
    nombres.set(fila.jid, fila.nombre);
    nombresPorNumero.set(numeroDe(fila.jid), fila.nombre);
  }

  const MAX_NOTAS = Number(process.env.MEMORIA_MAX_NOTAS) || 40;

  // Pasa filas a líneas "[19/10 20:15] Juan: hola" (lo que lee el modelo)
  const aLineas = (filas, { soloHora = false, max = 280 } = {}) =>
    filas
      .map((f) => `[${soloHora ? horaCorta(f.ts) : fechaHoraCorta(f.ts)}] ${f.es_bot ? 'CaDI' : f.autor}: ${recortar(f.texto, max)}`)
      .join('\n');

  // Se queda con las últimas líneas que entren en el máximo de caracteres
  function recortarDesdeElFinal(lineas, maxCaracteres) {
    const salida = [];
    let total = 0;
    for (let i = lineas.length - 1; i >= 0; i--) {
      total += lineas[i].length + 1;
      if (total > maxCaracteres && salida.length) break;
      salida.unshift(lineas[i]);
    }
    return salida;
  }

  const memoria = {
    activa: true,
    archivo,

    /** Guarda un mensaje. Devuelve true si era nuevo. */
    guardarMensaje({ waId = null, chat, autorJid = null, autor, texto, ts = ahoraSeg(), esBot = false, origen = 'vivo' }) {
      if (!chat || !texto) return false;
      const r = sql.insertar.run(waId, chat, autorJid, autor || 'Alguien', String(texto), Number(ts), esBot ? 1 : 0, origen);
      return r.changes > 0;
    },

    /** Alguien editó un mensaje: se actualiza el texto guardado */
    editarMensaje(chat, waId, texto) {
      if (!chat || !waId || !texto) return false;
      return sql.editar.run(String(texto), chat, waId).changes > 0;
    },

    /** Alguien lo borró "para todos": también se borra de la memoria */
    borrarMensaje(chat, waId) {
      if (!chat || !waId) return false;
      return sql.borrar.run(chat, waId).changes > 0;
    },

    /**
     * Últimos mensajes del chat, del más viejo al más nuevo.
     * @returns {{autor, autor_jid, texto, ts, es_bot}[]}
     */
    recientes(chat, { limite = 15, horas = 12, excluirWaId = null, maxCaracteres = 2500, maxPorMensaje = 300 } = {}) {
      const desde = ahoraSeg() - horas * 3600;
      const filas = sql.recientes.all(chat, desde, excluirWaId || '-', limite).reverse();
      const conTexto = filas.map((f) => ({ ...f, texto: recortar(f.texto, maxPorMensaje) }));
      // Respeta el máximo de caracteres descartando los más viejos
      let total = 0;
      const salida = [];
      for (let i = conTexto.length - 1; i >= 0; i--) {
        total += conTexto[i].texto.length + (conTexto[i].autor?.length || 0) + 10;
        if (total > maxCaracteres && salida.length) break;
        salida.unshift(conTexto[i]);
      }
      return salida;
    },

    /**
     * Busca en el historial de un chat. Con "consulta" busca por palabras (sin importar
     * tildes ni mayúsculas); sin consulta, devuelve lo que se habló en el rango de fechas.
     * Devuelve { total, texto } con el resultado ya listo para el modelo.
     */
    buscar(chat, { consulta = '', desde = null, hasta = null, autor = '', limite = 15, maxCaracteres = 3500 } = {}) {
      const ini = desde ?? 0;
      const fin = hasta ?? ahoraSeg() + 60;
      const autorN = normalizar(autor).trim();
      const delAutor = (f) => !autorN || normalizar(f.es_bot ? 'CaDI' : f.autor).includes(autorN);
      const q = consultaFts(consulta);

      let filas = [];
      if (q) {
        const columnaAutor = autorN ? ` AND autor : (${consultaFts(autor, { o: true }) || '""'})` : '';
        try {
          filas = sql.buscarFts.all(`(${q})${columnaAutor}`, chat, ini, fin, limite * 3).filter(delAutor);
          if (!filas.length) {
            // Nada con todas las palabras: probamos con cualquiera de ellas
            filas = sql.buscarFts.all(`(${consultaFts(consulta, { o: true })})${columnaAutor}`, chat, ini, fin, limite * 3).filter(delAutor);
          }
        } catch {
          filas = [];
        }
        filas = filas.slice(0, limite).sort((a, b) => a.ts - b.ts);
      } else {
        // Sin palabras clave: lo último que se habló en el rango (por defecto, las últimas 12 horas)
        const iniRango = desde ?? ahoraSeg() - 12 * 3600;
        filas = sql.rango.all(chat, iniRango, fin, autorN ? 1500 : 150).filter(delAutor).slice(0, 150).reverse();
      }

      if (!filas.length) {
        return { total: 0, texto: 'No encontré mensajes guardados que coincidan.' };
      }
      const lineas = recortarDesdeElFinal(aLineas(filas, { max: q ? 280 : 200 }).split('\n'), maxCaracteres);
      const aviso = lineas.length < filas.length ? ` (muestro los ${lineas.length} más recientes)` : '';
      return { total: filas.length, texto: `Encontré ${filas.length} mensaje(s)${aviso}:\n${lineas.join('\n')}` };
    },

    /** Guarda una nota permanente del chat. Devuelve { ok, id } o { ok: false, error } */
    guardarNota(chat, texto, autor = null) {
      const t = recortar(texto, 300);
      if (!chat || t.length < 3) return { ok: false, error: 'la nota está vacía' };
      if (sql.contarNotas.get(chat).n >= MAX_NOTAS) {
        return { ok: false, error: `ya hay ${MAX_NOTAS} notas guardadas; un administrador tiene que borrar alguna` };
      }
      const r = sql.insertarNota.run(chat, t, autor, ahoraSeg());
      return { ok: true, id: Number(r.lastInsertRowid) };
    },

    borrarNota(chat, id) {
      return sql.borrarNota.run(chat, Number(id)).changes > 0;
    },

    /** @returns {{id, texto, autor, ts}[]} */
    notas(chat) {
      return sql.notas.all(chat);
    },

    /** Resúmenes de los últimos días (sin contar hoy), del más viejo al más nuevo */
    resumenesRecientes(chat, { dias = 3, maxCaracteres = 1200 } = {}) {
      const hoy = fechaISO(ahoraSeg());
      const porFecha = new Map();
      for (const f of sql.resumenes.all(chat, hoy)) {
        if (!porFecha.has(f.fecha)) {
          if (porFecha.size >= dias) break;
          porFecha.set(f.fecha, []);
        }
        porFecha.get(f.fecha).push(f.texto);
      }
      const salida = [...porFecha.entries()]
        .map(([fecha, textos]) => ({ fecha, texto: recortar(textos.join(' '), 600) }))
        .reverse();
      // Si se pasan del máximo, se descartan los más viejos
      while (salida.length > 1 && salida.reduce((n, r) => n + r.texto.length + 12, 0) > maxCaracteres) salida.shift();
      return salida;
    },

    /**
     * Días (anteriores a hoy) que todavía no tienen resumen, partidos en bloques que
     * entran en un pedido a Groq. Los usa el workflow "CaDI - Resumen diario".
     */
    pendientesDeResumen({ maxDias = 7, minMensajes = 8, maxCaracteres = 12000, nombreDeChat = () => null } = {}) {
      const hoy = fechaISO(ahoraSeg());
      const desde = ahoraSeg() - (maxDias + 1) * 86400;
      const grupos = new Map(); // "chat|fecha" -> filas
      for (const f of sql.mensajesVivos.all(desde, ahoraSeg())) {
        const fecha = fechaISO(f.ts);
        if (fecha >= hoy) continue;
        const clave = `${f.chat}|${fecha}`;
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push(f);
      }
      const salida = [];
      for (const [clave, filas] of grupos) {
        const [chat, fecha] = clave.split('|');
        if (filas.length < minMensajes || sql.existeResumen.get(chat, fecha)) continue;
        // Bloques de hasta maxCaracteres, cortando entre mensajes (nunca a la mitad de uno)
        const lineas = aLineas(filas, { soloHora: true, max: 300 }).split('\n');
        const bloques = [[]];
        let largo = 0;
        for (const l of lineas) {
          if (largo + l.length > maxCaracteres && bloques.at(-1).length) {
            bloques.push([]);
            largo = 0;
          }
          bloques.at(-1).push(l);
          largo += l.length + 1;
        }
        bloques.forEach((b, i) =>
          salida.push({
            chat,
            nombreChat: nombreDeChat(chat),
            fecha,
            parte: i + 1,
            partes: bloques.length,
            mensajes: filas.length,
            texto: b.join('\n'),
          })
        );
      }
      return salida.sort((a, b) => (a.fecha === b.fecha ? a.parte - b.parte : a.fecha < b.fecha ? -1 : 1));
    },

    guardarResumen(chat, fecha, parte, texto) {
      if (!chat || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha)) || !String(texto ?? '').trim()) return false;
      sql.guardarResumen.run(chat, fecha, Number(parte) || 1, recortar(texto, 1500), ahoraSeg());
      return true;
    },

    /** Recuerda el nombre visible (pushName) de cada JID, solo si cambió */
    recordarNombre(jid, nombre) {
      const n = String(nombre ?? '').trim();
      if (!jid || !n || nombres.get(jid) === n) return;
      nombres.set(jid, n);
      nombresPorNumero.set(numeroDe(jid), n);
      sql.guardarNombre.run(jid, n, ahoraSeg());
    },

    nombreDe: (jid) => nombres.get(jid) ?? null,
    nombrePorNumero: (numero) => nombresPorNumero.get(String(numero)) ?? null,

    /** Fecha (segundos) del primer mensaje que vio el bridge en ese chat */
    primerMensajeVivo(chat) {
      return sql.primerVivo.get(chat)?.ts ?? null;
    },

    /**
     * Carga mensajes de un chat exportado. Saltea los que ya estaban (si importás dos
     * veces el mismo archivo) y los posteriores al primer mensaje que vio el bridge.
     * @param {string} chat
     * @param {{autor, texto, ts}[]} filas
     */
    importar(chat, filas) {
      const limite = memoria.primerMensajeVivo(chat) ?? Infinity;
      let insertados = 0;
      let salteados = 0;
      db.exec('BEGIN');
      try {
        for (const f of filas) {
          if (f.ts >= limite) {
            salteados++;
            continue;
          }
          const r = sql.insertar.run(null, chat, null, f.autor || 'Alguien', f.texto, f.ts, 0, 'export');
          if (r.changes > 0) insertados++;
          else salteados++;
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { insertados, salteados };
    },

    /** Borra mensajes más viejos que "dias" (0 = nunca borrar). Devuelve cuántos borró. */
    purgar(dias) {
      if (!dias || dias <= 0) return 0;
      return Number(sql.purgar.run(ahoraSeg() - dias * 86400).changes);
    },

    estadisticas() {
      let tamañoMB = null;
      try {
        tamañoMB = +(fs.statSync(archivo).size / 1048576).toFixed(1);
      } catch {}
      return {
        activa: true,
        mensajes: sql.contarMensajes.get().n,
        notas: sql.contarTodasNotas.get().n,
        resumenes: sql.contarResumenes.get().n,
        tamañoMB,
      };
    },

    cerrar() {
      try {
        db.close();
      } catch {}
    },
  };

  logger.info?.(`🧠 Memoria activa (${archivo})`);
  return memoria;
}
