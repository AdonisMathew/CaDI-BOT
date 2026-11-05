// CaDI - ¿Están llamando a todos?
//
// "@todos vengan al asado" o "@all" solo es un llamado: CaDI etiqueta a todos.
// "¿Funcionó el @todos?" o "lo cagó por usar el @all" no: ahí hablan DEL @todos, no lo usan,
// y etiquetar a todo el grupo por eso molesta (pasó en el grupo real).
// La regla: no cuenta si la palabra viene justo después de un artículo o posesivo.

const escapar = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Palabras que, justo antes de "@todos", indican que se habla del @todos y no que se lo usa
const ANTES_QUE_NO_LLAMAN = new Set(['el', 'del', 'al', 'un', 'ese', 'este', 'lo', 'tu', 'su', 'mi']);

export function crearDetectorDeTodos(palabras) {
  const lista = palabras.map((p) => p.trim()).filter(Boolean);
  if (!lista.length) return () => false;
  const regex = new RegExp(`(^|[\\s(¡¿])(${lista.map(escapar).join('|')})(?=$|[\\s.,;:!?)])`, 'gi');

  return function esLlamadoATodos(texto) {
    const t = String(texto || '');
    for (const m of t.matchAll(regex)) {
      const antes = t.slice(0, m.index + m[1].length).trimEnd();
      const palabraAnterior = (antes.match(/([\p{L}]+)$/u)?.[1] || '').toLowerCase();
      if (!ANTES_QUE_NO_LLAMAN.has(palabraAnterior)) return true; // basta un uso como llamado
    }
    return false;
  };
}
