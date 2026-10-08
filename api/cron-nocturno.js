// Corrección nocturna con la Batch API de Anthropic (mitad de precio). La lanza Vercel Cron:
//   ?fase=enviar  (≈2:00) lo recibido en tareas con «Corregir sola por la noche» va en un lote.
//   ?fase=recoger (≈7:00) se guardan las propuestas para que el profesor las revise y apruebe;
//                         lo que falla vuelve a estar disponible y se devuelve su corrección.
// En «recoger» también se borran los archivos que ya no hacen falta.
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { ErrorHttp, registrarUso, responderError, sbAdmin } from '../lib/servidor.js';
import {
  CURSOS_VALIDOS, FALLOS_COBRADOS, MODELO, cobrarCredito, devolverCredito, leerCorreccion, peticionCorreccion,
} from '../lib/correccion.js';
import { archivosDelAlumno, guardarCorreccion, marcarError, nombreCompleto, trabajoDeArchivos } from '../lib/entregas.js';

const client = new Anthropic();
const MAX_ALUMNOS_POR_NOCHE = 200;
const MAX_BYTES_LOTE = 100 * 1024 * 1024;   // la Batch API admite 256 MB; margen para la memoria de la función
const DIAS_CONSERVACION = 60;

function comprobarSecreto(req) {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) throw new ErrorHttp(503, 'Falta CRON_SECRET en Vercel.');
  const recibido = Buffer.from(String(req.headers.authorization ?? ''));
  const esperado = Buffer.from(`Bearer ${secreto}`);
  if (recibido.length !== esperado.length || !crypto.timingSafeEqual(recibido, esperado)) {
    throw new ErrorHttp(401, 'No autorizado.');
  }
}

async function enviar() {
  const { data: tareas, error } = await sbAdmin().from('tareas')
    .select('id,titulo,rubrica,grupo_id,owner_id').eq('correccion_auto', true).not('rubrica', 'is', null);
  if (error) throw error;
  if (!tareas?.length) return { enviados: 0 };

  const { data: pendientes, error: errP } = await sbAdmin().from('entregas')
    .select('tarea_id,alumno_id').in('tarea_id', tareas.map((t) => t.id))
    .eq('estado', 'pendiente').not('alumno_id', 'is', null).not('ruta', 'is', null);
  if (errP) throw errP;
  const pares = [...new Map((pendientes || []).map((p) => [`${p.tarea_id}|${p.alumno_id}`, p])).values()];
  if (!pares.length) return { enviados: 0 };

  const [{ data: grupos }, { data: alumnos }] = await Promise.all([
    sbAdmin().from('grupos').select('id,nivel').in('id', [...new Set(tareas.map((t) => t.grupo_id))]),
    sbAdmin().from('alumnos').select('id,nombre,apellidos').in('id', [...new Set(pares.map((p) => p.alumno_id))]),
  ]);

  const peticiones = [];
  const cobradas = [];
  let bytes = 0;
  let lote;
  try {
    for (const par of pares.slice(0, MAX_ALUMNOS_POR_NOCHE)) {
      const tarea = tareas.find((t) => t.id === par.tarea_id);
      const curso = grupos?.find((g) => g.id === tarea.grupo_id)?.nivel;
      const alumno = alumnos?.find((a) => a.id === par.alumno_id);
      if (!alumno || !CURSOS_VALIDOS.includes(curso)) continue;
      const filas = await archivosDelAlumno(tarea.id, alumno.id);
      if (!filas.length) continue;
      const ids = filas.map((f) => f.id);

      // Cada alumno por separado: si su archivo falla, solo él queda con error y el lote sigue
      let trabajo;
      try {
        trabajo = await trabajoDeArchivos(filas);
      } catch (e) {
        await marcarError(ids, `No se pudo preparar por la noche: ${e.message}`);
        continue;
      }
      if (!trabajo.length) continue;
      if (bytes + trabajo.bytes > MAX_BYTES_LOTE) break;   // lo que no cabe, mañana (tamaño real, no el declarado)

      try {
        await cobrarCredito(tarea.owner_id);
      } catch (e) {
        if (e.codigo === 'SIN_CREDITOS') continue;   // se queda pendiente: lo corregirá el profesor al comprar
        throw e;
      }
      const clave = filas[0].id.replace(/-/g, '');
      cobradas.push({ clave, owner: tarea.owner_id, ids });
      peticiones.push({
        custom_id: clave,
        params: peticionCorreccion({ nombre_alumno: nombreCompleto(alumno), curso, nombre_tarea: tarea.titulo, rubrica: tarea.rubrica, trabajo }),
      });
      bytes += trabajo.bytes;
    }
    if (!peticiones.length) return { enviados: 0 };
    lote = await client.messages.batches.create({ requests: peticiones });
  } catch (error) {
    // El lote no llegó a crearse: se devuelve todo lo cobrado y mañana se reintenta
    for (const c of cobradas) await devolverCredito(c.owner, 'cron-nocturno');
    throw error;
  }

  const { data: fila, error: errLote } = await sbAdmin().from('lotes_ia').insert({ batch_id: lote.id }).select('id').single();
  if (errLote) {
    // Sin registro del lote no se podrían recoger sus resultados: se devuelve todo
    for (const c of cobradas) await devolverCredito(c.owner, 'cron-nocturno');
    throw errLote;
  }
  let enviados = 0;
  for (const c of cobradas) {
    const { error: errUpd } = await sbAdmin().from('entregas')
      .update({ estado: 'corrigiendo', lote_id: fila.id, lote_clave: c.clave }).in('id', c.ids);
    if (errUpd) {
      console.error('[cron-nocturno] No se pudo marcar el lote:', errUpd.message);
      await devolverCredito(c.owner, 'cron-nocturno');   // su resultado se ignorará; queda pendiente
    } else enviados++;
  }
  return { enviados, lote: lote.id };
}

async function fallo(ids, owner, motivo, devolver = true) {
  await marcarError(ids, `No se pudo corregir por la noche (${motivo}). Pulsa «Corregir lo recibido».`);
  if (devolver) await devolverCredito(owner, 'cron-nocturno');
}

async function recoger() {
  const resumen = { corregidas: 0, fallidas: 0, lotes_en_curso: 0 };
  let errorLotes = null;
  try {
    await recogerLotes(resumen);
  } catch (e) {
    errorLotes = e;
  }
  // La limpieza va aparte: aunque falle un lote, los archivos que tocan se borran
  const limpieza = await limpiar();
  if (errorLotes) throw errorLotes;
  return { ...resumen, ...limpieza };
}

async function recogerLotes(resumen) {
  const { data: lotes, error } = await sbAdmin().from('lotes_ia').select('id,batch_id').eq('estado', 'enviado');
  if (error) throw error;

  for (const lote of lotes || []) {
    const info = await client.messages.batches.retrieve(lote.batch_id);
    if (info.processing_status !== 'ended') { resumen.lotes_en_curso++; continue; }

    const { data: filas, error: errF } = await sbAdmin().from('entregas')
      .select('id,owner_id,lote_clave').eq('lote_id', lote.id).eq('estado', 'corrigiendo');
    if (errF) throw errF;
    const porClave = {};
    for (const f of filas || []) (porClave[f.lote_clave] ??= []).push(f);

    for await (const r of await client.messages.batches.results(lote.batch_id)) {
      const grupo = porClave[r.custom_id];
      if (!grupo) continue;
      delete porClave[r.custom_id];
      const ids = grupo.map((f) => f.id);
      const owner = grupo[0].owner_id;
      if (r.result?.type !== 'succeeded') {
        await fallo(ids, owner, r.result?.type ?? 'sin resultado');
        await registrarUso(owner, 'correccion_lote', MODELO, null, false);
        resumen.fallidas++;
        continue;
      }
      await registrarUso(owner, 'correccion_lote', MODELO, r.result.message.usage, true);
      try {
        await guardarCorreccion(ids, leerCorreccion(r.result.message));
        resumen.corregidas++;
      } catch (e) {
        // Si la IA trabajó (rechazo o respuesta cortada), ya está pagada: no se devuelve
        await fallo(ids, owner, e.message, !FALLOS_COBRADOS.includes(e.codigo));
        resumen.fallidas++;
      }
    }
    // Lo que no vino en los resultados
    for (const grupo of Object.values(porClave)) {
      await fallo(grupo.map((f) => f.id), grupo[0].owner_id, 'sin respuesta');
      await registrarUso(grupo[0].owner_id, 'correccion_lote', MODELO, null, false);
      resumen.fallidas++;
    }
    const { error: errL } = await sbAdmin().from('lotes_ia').update({ estado: 'recogido' }).eq('id', lote.id);
    if (errL) throw errL;
  }
}

/** No guardar trabajos de alumnos más de lo necesario */
async function limpiar() {
  const hace = (horas) => new Date(Date.now() - horas * 3600_000).toISOString();
  const borrarArchivos = async (rutas) => {
    rutas = rutas.filter(Boolean);
    for (let i = 0; i < rutas.length; i += 500) {
      const { error } = await sbAdmin().storage.from('entregas').remove(rutas.slice(i, i + 500));
      if (error) throw error;
    }
    return rutas.length;
  };
  let borrados = 0;

  // 1. Aprobadas o descartadas: fuera el archivo y la propuesta de la IA (la nota aprobada ya está en el cuaderno)
  const { data: cerradas, error: errC } = await sbAdmin().from('entregas').select('id,ruta')
    .in('estado', ['aprobada', 'descartada']).or('ruta.not.is.null,resultado.not.is.null').limit(1000);
  if (errC) throw errC;
  if (cerradas?.length) {
    borrados += await borrarArchivos(cerradas.map((f) => f.ruta));
    const { error } = await sbAdmin().from('entregas').update({ ruta: null, resultado: null }).in('id', cerradas.map((f) => f.id));
    if (error) throw error;
  }

  // 2. Lo de más de 60 días y las subidas abandonadas (más de 2 horas): fuera la fila entera.
  //    El trigger de la tabla apunta sus archivos en `archivos_por_borrar`.
  for (const consulta of [
    sbAdmin().from('entregas').delete().lt('created_at', hace(DIAS_CONSERVACION * 24)),
    sbAdmin().from('entregas').delete().eq('estado', 'subiendo').lt('created_at', hace(2)),
  ]) {
    const { error } = await consulta;
    if (error) throw error;
  }

  // 3. Archivos sin entrega (borradas por el profesor, tareas o cuentas eliminadas, y lo del paso 2)
  const { data: huerfanos, error: errH } = await sbAdmin().from('archivos_por_borrar').select('ruta').limit(1000);
  if (errH) throw errH;
  if (huerfanos?.length) {
    borrados += await borrarArchivos(huerfanos.map((f) => f.ruta));
    const { error } = await sbAdmin().from('archivos_por_borrar').delete().in('ruta', huerfanos.map((f) => f.ruta));
    if (error) throw error;
  }
  return { archivos_borrados: borrados };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  try {
    comprobarSecreto(req);
    const fase = req.query?.fase;
    if (fase === 'enviar') return res.status(200).json(await enviar());
    if (fase === 'recoger') return res.status(200).json(await recoger());
    throw new ErrorHttp(400, 'Fase no válida: usa ?fase=enviar o ?fase=recoger');
  } catch (error) {
    return responderError(res, error, 'cron-nocturno');
  }
}
