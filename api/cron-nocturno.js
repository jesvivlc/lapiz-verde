// Corrección nocturna con la Batch API de Anthropic (mitad de precio). La lanza Vercel Cron:
//   ?fase=enviar  (≈2:00) lo recibido en tareas con «Corregir sola por la noche» va en un lote.
//   ?fase=recoger (≈7:00) se guardan las propuestas para que el profesor las revise y apruebe;
//                         lo que falla vuelve a estar disponible y se devuelve su corrección.
// En «recoger» también se borran los archivos que ya no hacen falta.
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { ErrorHttp, registrarUso, responderError, sbAdmin } from '../lib/servidor.js';
import {
  CURSOS_VALIDOS, MODELO, cobrarCredito, devolverCredito, leerCorreccion, peticionCorreccion,
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
      const tamano = filas.reduce((s, f) => s + (f.bytes || 0), 0);
      if (!filas.length) continue;
      if (bytes + tamano > MAX_BYTES_LOTE) break;   // lo que no cabe, mañana

      try {
        await cobrarCredito(tarea.owner_id);
      } catch (e) {
        if (e.codigo === 'SIN_CREDITOS') continue;   // se queda pendiente: lo corregirá el profesor al comprar
        throw e;
      }
      const clave = filas[0].id.replace(/-/g, '');
      cobradas.push({ clave, owner: tarea.owner_id, ids: filas.map((f) => f.id) });
      const trabajo = await trabajoDeArchivos(filas);
      peticiones.push({
        custom_id: clave,
        params: peticionCorreccion({ nombre_alumno: nombreCompleto(alumno), curso, nombre_tarea: tarea.titulo, rubrica: tarea.rubrica, trabajo }),
      });
      bytes += tamano;
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

async function fallo(ids, owner, motivo) {
  await marcarError(ids, `No se pudo corregir por la noche (${motivo}). Pulsa «Corregir lo recibido».`);
  await devolverCredito(owner, 'cron-nocturno');
  await registrarUso(owner, 'correccion_lote', MODELO, null, false);
}

async function recoger() {
  const { data: lotes, error } = await sbAdmin().from('lotes_ia').select('id,batch_id').eq('estado', 'enviado');
  if (error) throw error;
  const resumen = { corregidas: 0, fallidas: 0, lotes_en_curso: 0 };

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
      try {
        if (r.result?.type !== 'succeeded') throw new Error(r.result?.type ?? 'sin resultado');
        await guardarCorreccion(ids, leerCorreccion(r.result.message));
        await registrarUso(owner, 'correccion_lote', MODELO, r.result.message.usage, true);
        resumen.corregidas++;
      } catch (e) {
        await fallo(ids, owner, e.message);
        resumen.fallidas++;
      }
    }
    // Lo que no vino en los resultados
    for (const grupo of Object.values(porClave)) {
      await fallo(grupo.map((f) => f.id), grupo[0].owner_id, 'sin respuesta');
      resumen.fallidas++;
    }
    const { error: errL } = await sbAdmin().from('lotes_ia').update({ estado: 'recogido' }).eq('id', lote.id);
    if (errL) throw errL;
  }
  return { ...resumen, ...(await limpiar()) };
}

/** No guardar trabajos de alumnos más de lo necesario */
async function limpiar() {
  const hace = (dias) => new Date(Date.now() - dias * 86_400_000).toISOString();
  const borrarArchivos = async (filas) => {
    const rutas = filas.map((f) => f.ruta).filter(Boolean);
    for (let i = 0; i < rutas.length; i += 500) {
      const { error } = await sbAdmin().storage.from('entregas').remove(rutas.slice(i, i + 500));
      if (error) throw error;
    }
  };

  // Aprobadas o descartadas, y todo lo que pase de 60 días: fuera el archivo, queda el registro
  const [{ data: cerradas }, { data: viejas }] = await Promise.all([
    sbAdmin().from('entregas').select('id,ruta').in('estado', ['aprobada', 'descartada']).not('ruta', 'is', null).limit(1000),
    sbAdmin().from('entregas').select('id,ruta').lt('created_at', hace(DIAS_CONSERVACION)).not('ruta', 'is', null).limit(1000),
  ]);
  const sinArchivo = [...new Map([...(cerradas || []), ...(viejas || [])].map((f) => [f.id, f])).values()];
  await borrarArchivos(sinArchivo);
  if (sinArchivo.length) {
    const { error } = await sbAdmin().from('entregas').update({ ruta: null }).in('id', sinArchivo.map((f) => f.id));
    if (error) throw error;
  }

  // Subidas que nunca se completaron
  const { data: abandonadas } = await sbAdmin().from('entregas').select('id,ruta')
    .eq('estado', 'subiendo').lt('created_at', hace(1)).limit(1000);
  await borrarArchivos(abandonadas || []);
  if (abandonadas?.length) {
    const { error } = await sbAdmin().from('entregas').delete().in('id', abandonadas.map((f) => f.id));
    if (error) throw error;
  }
  return { archivos_borrados: sinArchivo.length + (abandonadas?.length ?? 0) };
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
