// Pruebas de todos.js. Correr con: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearDetectorDeTodos } from '../todos.js';

const esLlamado = crearDetectorDeTodos(['@todos', '@all', '@everyone', '@todes']);

test('es un llamado cuando se usa la palabra', () => {
  for (const t of ['@all', '@todos', '@todos vengan al asado', 'che @todos, ¿quién viene?', 'vamos @ALL', '(@todos)', '¡@todos!', 'mañana a las 21 @todes']) {
    assert.equal(esLlamado(t), true, t);
  }
});

test('no es un llamado cuando se habla del @todos', () => {
  for (const t of ['Funcionó el @todos de cadi? les llegó la notificación?', 'Por usar el @all', 'cuidado con este @todos', 'qué pesado tu @all', 'mandaste un @todos?']) {
    assert.equal(esLlamado(t), false, t);
  }
});

test('alcanza con un uso como llamado aunque también se hable del @todos', () => {
  assert.equal(esLlamado('no funcionó el @all, así que: @todos asado a las 22'), true);
});

test('no confunde palabras parecidas ni mails', () => {
  for (const t of ['@todosss', 'matias@all.com', 'todos vengan', '', undefined]) {
    assert.equal(esLlamado(t), false, String(t));
  }
});

test('sin palabras configuradas no detecta nada', () => {
  assert.equal(crearDetectorDeTodos([])('@todos'), false);
});
