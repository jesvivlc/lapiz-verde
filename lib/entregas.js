// Utilidades para corregir lo que ha llegado a la tabla `entregas` (enlace o correo).
import { sbAdmin } from './servidor.js';
import { MAX_ARCHIVOS, bloqueDeArchivo, tipoDeMime } from './correccion.js';

// Si un alumno entrega algo nuevo, se vuelve a corregir junto con lo que ya tenía
export const ESTADOS_CORREGIBLES = ['pendiente', 'error', 'corregida'];
export const MAX_BYTES_POR_ALUMNO = 24 * 1024 * 1024;   // la API de Anthropic admite 32 MB por petición

export function nombreCompleto(alumno) {
  return [alumno.nombre, alumno.apellidos].filter(Boolean).join(' ');
}

/** Archivos de un alumno en una tarea que entran en la corrección (los más recientes, en orden) */
export async function archivosDelAlumno(tareaId, alumnoId) {
  const { data, error } = await sbAdmin().from('entregas')
    .select('id,ruta,mime,bytes,estado,created_at')
    .eq('tarea_id', tareaId).eq('alumno_id', alumnoId)
    .in('estado', ESTADOS_CORREGIBLES).not('ruta', 'is', null)
    .order('created_at', { ascending: false }).limit(MAX_ARCHIVOS);
  if (error) throw error;
  // Vienen del más nuevo al más viejo: se quedan los más recientes que quepan
  // en el límite de la IA, y se devuelven en el orden en que se entregaron
  let total = 0;
  return (data || []).filter((f) => (total += f.bytes || 0) <= MAX_BYTES_POR_ALUMNO).reverse();
}

/** Descarga los archivos del almacén y los convierte en bloques para la IA */
export async function trabajoDeArchivos(filas) {
  const bloques = [];
  for (const f of filas) {
    const tipo = tipoDeMime(f.mime);
    if (!tipo) continue;
    const { data, error } = await sbAdmin().storage.from('entregas').download(f.ruta);
    if (error) throw error;
    const base64 = Buffer.from(await data.arrayBuffer()).toString('base64');
    bloques.push(bloqueDeArchivo(base64, tipo));
  }
  return bloques;
}

export async function guardarCorreccion(ids, resultado) {
  const { error } = await sbAdmin().from('entregas')
    .update({ estado: 'corregida', resultado, error: null, corregida_at: new Date().toISOString() })
    .in('id', ids);
  if (error) throw error;
}

export async function marcarError(ids, mensaje) {
  const { error } = await sbAdmin().from('entregas')
    .update({ estado: 'error', error: String(mensaje).slice(0, 300) }).in('id', ids);
  if (error) console.error('[entregas] No se pudo marcar el error:', error.message);
}
