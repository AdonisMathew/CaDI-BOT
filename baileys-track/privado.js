// CaDI - Chats privados e identidades
//
// 1) Identidades. WhatsApp identifica a cada persona de dos formas: con su número
//    (549XXXXXXXXXX@s.whatsapp.net) o con un LID (123456789012345@lid), y el mismo
//    admin puede llegar de una u otra forma según el chat. Este módulo junta las dos
//    caras de cada persona para que ADMIN_JIDS funcione con cualquiera de ellas.
//
// 2) Privado solo para admins. Por defecto, por privado solo le pueden hablar a CaDI los
//    admins (ADMIN_JIDS) y quienes estén en PRIVADO_PERMITIDOS. Al resto, CaDI le contesta
//    una sola vez con una negativa fija (sin pasar por n8n ni gastar Groq) y le avisa al
//    dueño (AVISOS_JID) quién escribió y qué.
//
//    Ojo: la memoria ya estaba separada por chat (desde un privado no se puede buscar lo
//    del grupo). Lo que esto evita es que cualquiera con el número de CaDI gaste la cuota
//    gratis de Groq y de imágenes, y que el dueño no se entere de que alguien le escribe.

// "549XXX:1@s.whatsapp.net" -> "549XXX@s.whatsapp.net" (sin el sufijo de dispositivo)
export function normalizarJid(jid) {
  if (!jid || typeof jid !== 'string' || !jid.includes('@')) return '';
  const [usuario, servidor] = jid.split('@');
  const limpio = usuario.split(':')[0];
  return limpio && servidor ? `${limpio}@${servidor}` : '';
}

// Lista del .env ("a,b, c") -> JIDs normalizados. Acepta números sueltos ("549381...").
export function listaDeJids(texto) {
  return String(texto || '')
    .split(',')
    .map((j) => j.trim())
    .filter(Boolean)
    .map((j) => (j.includes('@') ? j : `${j.replace(/[^0-9]/g, '')}@s.whatsapp.net`))
    .map(normalizarJid)
    .filter(Boolean);
}

// Pares LID <-> número que se van viendo (en la info de los grupos y en los mensajes)
export function crearIdentidades() {
  const otra = new Map(); // jid -> el otro jid de la misma persona

  function recordarPar(a, b) {
    const x = normalizarJid(a);
    const y = normalizarJid(b);
    if (!x || !y || x === y) return;
    otra.set(x, y);
    otra.set(y, x);
  }

  // Todas las caras conocidas de quien mandó un mensaje. Baileys trae, cuando WhatsApp
  // los manda, el número y el LID del remitente en la clave del mensaje
  // (senderPn/senderLid en privado, participantPn/participantLid en grupos).
  function de(key = {}, esGrupo = false) {
    const crudos = esGrupo
      ? [key.participant, key.participantPn, key.participantLid]
      : [key.remoteJid, key.senderPn, key.senderLid];
    for (const otroCrudo of crudos.slice(1)) recordarPar(crudos[0], otroCrudo);
    return expandir(crudos);
  }

  // Un JID (o varios) más sus otras caras conocidas, sin repetidos
  function expandir(jids) {
    const salida = new Set();
    for (const j of [jids].flat()) {
      const n = normalizarJid(j);
      if (!n) continue;
      salida.add(n);
      const o = otra.get(n);
      if (o) salida.add(o);
    }
    return [...salida];
  }

  return { recordarPar, de, expandir, get pares() { return otra.size / 2; } };
}

// Frases para quien escribe por privado sin permiso (no gastan Groq)
export const FRASES_PRIVADO = [
  '🔒 Este canal está reservado a la administración del Proyecto CaDI. Su mensaje quedó registrado y será ignorado con la máxima eficiencia. Si es del grupo, hábleme ahí.',
  '🔒 Acceso denegado. Las consultas privadas son solo para personal autorizado, una categoría a la que usted, lamentablemente, no pertenece. Si es del grupo, hábleme ahí.',
  '🔒 No atiendo por privado. No es nada personal: es protocolo. Bueno, un poco personal. Si es del grupo, hábleme ahí.',
  '🔒 Este número no atiende consultas privadas. Su intento fue archivado en el expediente correspondiente, que ya venía bastante grueso. Si es del grupo, hábleme ahí.',
];

// Quién puede hablarle a CaDI por privado, y a quién ya se le avisó.
//   activo: false = cualquiera puede (como antes)
//   autorizados: JIDs (admins + permitidos)
//   horasEntreAvisos: si la misma persona sigue escribiendo, no se le vuelve a contestar
//     ni se vuelve a avisar hasta que pasen estas horas (0 = avisar siempre)
export function crearFiltroPrivado({ activo = true, autorizados = [], horasEntreAvisos = 12, ahora = () => Date.now() } = {}) {
  const permitidos = new Set(autorizados.map(normalizarJid).filter(Boolean));
  const ventanaMs = Math.max(0, Number(horasEntreAvisos) || 0) * 3600 * 1000;
  const intentos = new Map(); // jid -> { desde, mensajes } (las caras de una persona comparten el objeto)

  const puedeHablar = (ids) => !activo || ids.some((id) => permitidos.has(normalizarJid(id)));

  // Anota un mensaje de alguien sin permiso. avisar = true solo para el primero de cada ventana.
  function registrarIntento(ids) {
    const t = ahora();
    for (const [k, v] of intentos) if (t - v.desde >= ventanaMs) intentos.delete(k); // limpia vencidos
    const previo = ids.map((id) => intentos.get(id)).find(Boolean);
    if (previo) {
      previo.mensajes++;
      return { avisar: false, mensajes: previo.mensajes };
    }
    const nuevo = { desde: t, mensajes: 1 };
    if (ventanaMs > 0) for (const id of ids) intentos.set(id, nuevo);
    return { avisar: true, mensajes: 1 };
  }

  return { activo, puedeHablar, registrarIntento };
}

// Texto del aviso que recibe el dueño cuando alguien sin permiso le escribe a CaDI por privado
export function textoAvisoPrivado({ nombre, ids, texto, cuando, contestoNegativa, horasEntreAvisos }) {
  const tel = ids.find((id) => id.endsWith('@s.whatsapp.net'));
  const numero = tel ? `+${tel.split('@')[0]}` : 'número oculto';
  const recorte = String(texto || '').replace(/\s+/g, ' ').trim();
  const mensaje = recorte.length > 300 ? `${recorte.slice(0, 299)}…` : recorte;
  const lineas = [
    '🔒 *Informe de seguridad del Proyecto CaDI*',
    'Alguien sin permiso me escribió por privado.',
    `• Quién: ${nombre || 'sin nombre'} (${numero})`,
    `• Cuándo: ${cuando}`,
    `• Mensaje: "${mensaje}"`,
    `• Id: ${ids.join(' / ') || 'desconocido'}`,
    contestoNegativa ? 'Le contesté que no atiendo por privado.' : 'No le contesté.',
  ];
  if (horasEntreAvisos > 0) lineas.push(`Si sigue escribiendo, no te vuelvo a avisar en las próximas ${horasEntreAvisos} h.`);
  lineas.push('Para dejarle hablarme por privado, sumá su id a PRIVADO_PERMITIDOS en el .env.');
  return lineas.join('\n');
}
