// Pruebas de privado.js. Correr con: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearFiltroPrivado, crearIdentidades, listaDeJids, normalizarJid, textoAvisoPrivado } from '../privado.js';

const ADMIN_TEL = '5493810000001@s.whatsapp.net';
const ADMIN_LID = '111111111111111@lid';
const OTRO_TEL = '5493810000009@s.whatsapp.net';
const OTRO_LID = '999999999999999@lid';

test('normalizarJid saca el sufijo de dispositivo y descarta basura', () => {
  assert.equal(normalizarJid('5493810000001:12@s.whatsapp.net'), ADMIN_TEL);
  assert.equal(normalizarJid('111111111111111:3@lid'), ADMIN_LID);
  assert.equal(normalizarJid(''), '');
  assert.equal(normalizarJid(undefined), '');
  assert.equal(normalizarJid('sin-arroba'), '');
});

test('listaDeJids acepta JIDs y números sueltos', () => {
  assert.deepEqual(listaDeJids(` ${ADMIN_LID}, 549 381 000-0001 ,,`), [ADMIN_LID, ADMIN_TEL]);
  assert.deepEqual(listaDeJids(''), []);
  assert.deepEqual(listaDeJids(undefined), []);
});

test('identidades: el par LID-número se aprende de la clave del mensaje', () => {
  const ids = crearIdentidades();
  // Privado que llega con LID, y WhatsApp manda también el número (senderPn)
  assert.deepEqual(ids.de({ remoteJid: ADMIN_LID, senderPn: ADMIN_TEL }, false).sort(), [ADMIN_LID, ADMIN_TEL].sort());
  // Después, aunque llegue solo el LID, ya se sabe el número
  assert.deepEqual(ids.de({ remoteJid: ADMIN_LID }, false).sort(), [ADMIN_LID, ADMIN_TEL].sort());
  assert.equal(ids.pares, 1);
});

test('identidades: en grupos se usa participant y participantPn/participantLid', () => {
  const ids = crearIdentidades();
  const r = ids.de({ remoteJid: '120363000000000000@g.us', participant: OTRO_TEL, participantLid: OTRO_LID }, true);
  assert.deepEqual(r.sort(), [OTRO_LID, OTRO_TEL].sort());
  // El chat del grupo nunca cuenta como identidad
  assert.ok(!r.includes('120363000000000000@g.us'));
});

test('identidades: el par se aprende de la info del grupo (recordarPar)', () => {
  const ids = crearIdentidades();
  ids.recordarPar(ADMIN_TEL, ADMIN_LID);
  ids.recordarPar(undefined, OTRO_LID); // datos incompletos: se ignoran
  ids.recordarPar(OTRO_LID, OTRO_LID);
  assert.deepEqual(ids.expandir(ADMIN_LID).sort(), [ADMIN_LID, ADMIN_TEL].sort());
  assert.deepEqual(ids.expandir(OTRO_LID), [OTRO_LID]);
  assert.equal(ids.pares, 1);
});

test('filtro: admins y permitidos pasan; el resto no', () => {
  const f = crearFiltroPrivado({ activo: true, autorizados: [ADMIN_TEL] });
  assert.equal(f.puedeHablar([ADMIN_LID, ADMIN_TEL]), true);
  assert.equal(f.puedeHablar([ADMIN_LID]), false); // sin el par aprendido no hay forma de saberlo
  assert.equal(f.puedeHablar([OTRO_TEL]), false);
  assert.equal(f.puedeHablar([]), false);
});

test('filtro apagado: pasa cualquiera (comportamiento anterior)', () => {
  const f = crearFiltroPrivado({ activo: false, autorizados: [] });
  assert.equal(f.puedeHablar([OTRO_TEL]), true);
});

test('filtro: avisa una sola vez por persona en la ventana, aunque cambie de cara', () => {
  let ahora = 0;
  const f = crearFiltroPrivado({ activo: true, autorizados: [ADMIN_TEL], horasEntreAvisos: 12, ahora: () => ahora });
  assert.deepEqual(f.registrarIntento([OTRO_TEL, OTRO_LID]), { avisar: true, mensajes: 1 });
  ahora += 60_000;
  assert.deepEqual(f.registrarIntento([OTRO_LID]), { avisar: false, mensajes: 2 });
  ahora += 11 * 3600_000;
  assert.deepEqual(f.registrarIntento([OTRO_TEL]), { avisar: false, mensajes: 3 });
  ahora += 3600_000; // ya pasaron 12 h desde el primero
  assert.deepEqual(f.registrarIntento([OTRO_TEL]), { avisar: true, mensajes: 1 });
});

test('filtro: con 0 horas avisa siempre', () => {
  const f = crearFiltroPrivado({ activo: true, autorizados: [], horasEntreAvisos: 0 });
  assert.equal(f.registrarIntento([OTRO_TEL]).avisar, true);
  assert.equal(f.registrarIntento([OTRO_TEL]).avisar, true);
});

test('aviso: muestra el número si se conoce, recorta el mensaje y explica qué hacer', () => {
  const largo = 'a'.repeat(400);
  const t = textoAvisoPrivado({
    nombre: 'Juan',
    ids: [OTRO_LID, OTRO_TEL],
    texto: `hola\n\n${largo}`,
    cuando: '04/11/2026 19:30',
    contestoNegativa: true,
    horasEntreAvisos: 12,
  });
  assert.match(t, /Juan \(\+5493810000009\)/);
  assert.match(t, /04\/11\/2026 19:30/);
  assert.match(t, /Le contesté que no atiendo por privado/);
  assert.match(t, /próximas 12 h/);
  assert.match(t, /PRIVADO_PERMITIDOS/);
  const mensaje = t.split('\n').find((l) => l.startsWith('• Mensaje:'));
  assert.ok(mensaje.length < 330, 'el mensaje se recorta');
  assert.ok(!mensaje.includes('\n'));
});

test('aviso: sin número conocido dice "número oculto"', () => {
  const t = textoAvisoPrivado({ nombre: '', ids: [OTRO_LID], texto: 'hola', cuando: 'ahora', contestoNegativa: false, horasEntreAvisos: 0 });
  assert.match(t, /sin nombre \(número oculto\)/);
  assert.match(t, /No le contesté/);
  assert.ok(!t.includes('próximas'));
});
