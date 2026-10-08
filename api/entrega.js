// Enlace de entrega: el alumno abre /entregar.html?t=<token>, elige su nombre y sube su trabajo.
// Sin cuenta: lo único que le da acceso es el token secreto de la tarea.
//   GET  ?t=…                                  → tarea, grupo y lista de alumnos (nombre + inicial)
//   POST { accion: 'preparar', t, alumno_id, archivos: [{ nombre, mime, bytes }] } → URLs firmadas de subida
//   POST { accion: 'confirmar', t, ids }       → marca como recibidas las que ya están en el almacén
import crypto from 'node:crypto';
import { ErrorHttp, prepararRespuesta, responderError, sbAdmin } from '../lib/servidor.js';
import { MAX_ARCHIVOS } from '../lib/correccion.js';

const TOKEN_VALIDO = /^[A-Za-z0-9_-]{32,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_POR_ALUMNO = 30;          // archivos por alumno y tarea, en total
const MAX_POR_HORA_TAREA = 300;     // archivos por tarea en la última hora
const EXTENSION = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

async function tareaDelToken(t) {
  if (typeof t !== 'string' || !TOKEN_VALIDO.test(t)) throw new ErrorHttp(404, 'Este enlace no es válido.');
  const { data, error } = await sbAdmin().from('tareas')
    .select('id,titulo,grupo_id,owner_id,entrega_abierta').eq('token_entrega', t).maybeSingle();
  if (error) throw error;
  if (!data) throw new ErrorHttp(404, 'Este enlace no es válido.');
  if (!data.entrega_abierta) throw new ErrorHttp(410, 'Tu profe ha cerrado la entrega de esta tarea.');
  return data;
}

/** "Ana" + "López García" → "Ana L." (o "Ana López" si hay otra "Ana L.") */
export function etiquetasAlumnos(alumnos) {
  const corta = (a) => [a.nombre, a.apellidos ? a.apellidos.trim()[0] + '.' : ''].filter(Boolean).join(' ');
  const larga = (a) => [a.nombre, (a.apellidos || '').trim().split(/\s+/)[0]].filter(Boolean).join(' ');
  const veces = {};
  for (const a of alumnos) veces[corta(a)] = (veces[corta(a)] || 0) + 1;
  return alumnos.map((a) => ({ id: a.id, etiqueta: veces[corta(a)] > 1 ? larga(a) : corta(a) }));
}

async function info(req, res) {
  const tarea = await tareaDelToken(req.query?.t);
  const [{ data: grupo }, { data: alumnos, error }] = await Promise.all([
    sbAdmin().from('grupos').select('nombre').eq('id', tarea.grupo_id).maybeSingle(),
    sbAdmin().from('alumnos').select('id,nombre,apellidos')
      .eq('grupo_id', tarea.grupo_id).eq('activo', true).order('nombre').order('apellidos'),
  ]);
  if (error) throw error;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    tarea: { titulo: tarea.titulo },
    grupo: { nombre: grupo?.nombre ?? '' },
    alumnos: etiquetasAlumnos(alumnos || []),
  });
}

async function preparar(body, res) {
  const tarea = await tareaDelToken(body.t);
  const archivos = Array.isArray(body.archivos) ? body.archivos : [];
  if (!archivos.length) throw new ErrorHttp(400, 'Elige al menos un archivo.');
  if (archivos.length > MAX_ARCHIVOS) throw new ErrorHttp(400, `Como máximo ${MAX_ARCHIVOS} archivos de una vez.`);
  for (const a of archivos) {
    if (!EXTENSION[a?.mime]) throw new ErrorHttp(400, `"${String(a?.nombre ?? '').slice(0, 60)}" no es un PDF ni una foto.`);
    if (!(Number(a.bytes) > 0) || Number(a.bytes) > MAX_BYTES) {
      throw new ErrorHttp(400, `"${String(a.nombre).slice(0, 60)}" ocupa demasiado (máximo 15 MB).`);
    }
  }

  if (!UUID.test(String(body.alumno_id ?? ''))) throw new ErrorHttp(400, 'Elige tu nombre de la lista.');
  const { data: alumno, error: errAlumno } = await sbAdmin().from('alumnos')
    .select('id').eq('id', body.alumno_id).eq('grupo_id', tarea.grupo_id).eq('activo', true).maybeSingle();
  if (errAlumno) throw errAlumno;
  if (!alumno) throw new ErrorHttp(400, 'Elige tu nombre de la lista.');

  const haceUnaHora = new Date(Date.now() - 3600_000).toISOString();
  const [{ count: delAlumno }, { count: ultimaHora }] = await Promise.all([
    sbAdmin().from('entregas').select('id', { count: 'exact', head: true })
      .eq('tarea_id', tarea.id).eq('alumno_id', alumno.id),
    sbAdmin().from('entregas').select('id', { count: 'exact', head: true })
      .eq('tarea_id', tarea.id).gte('created_at', haceUnaHora),
  ]);
  if ((delAlumno ?? 0) + archivos.length > MAX_POR_ALUMNO) {
    throw new ErrorHttp(429, 'Ya has entregado muchos archivos en esta tarea. Habla con tu profe.');
  }
  if ((ultimaHora ?? 0) + archivos.length > MAX_POR_HORA_TAREA) {
    throw new ErrorHttp(429, 'Hay muchas entregas ahora mismo. Prueba dentro de un rato.');
  }

  const filas = archivos.map((a) => {
    const id = crypto.randomUUID();
    return {
      id,
      owner_id: tarea.owner_id,
      tarea_id: tarea.id,
      alumno_id: alumno.id,
      canal: 'enlace',
      ruta: `${tarea.owner_id}/${tarea.id}/${id}.${EXTENSION[a.mime]}`,
      nombre_fichero: String(a.nombre ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 120),
      mime: a.mime,
      bytes: Math.round(Number(a.bytes)),
      estado: 'subiendo',
    };
  });
  const { error: errInsert } = await sbAdmin().from('entregas').insert(filas);
  if (errInsert) throw errInsert;

  const subidas = [];
  for (const f of filas) {
    const { data, error } = await sbAdmin().storage.from('entregas').createSignedUploadUrl(f.ruta);
    if (error) throw error;
    subidas.push({ id: f.id, url: data.signedUrl, mime: f.mime });
  }
  return res.status(200).json({ subidas });
}

async function confirmar(body, res) {
  const tarea = await tareaDelToken(body.t);
  const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x) => typeof x === 'string' && UUID.test(x)).slice(0, MAX_ARCHIVOS);
  if (!ids.length) throw new ErrorHttp(400, 'No hay nada que confirmar.');

  const { data: filas, error } = await sbAdmin().from('entregas')
    .select('id,ruta').eq('tarea_id', tarea.id).eq('estado', 'subiendo').in('id', ids);
  if (error) throw error;

  // Solo se da por recibido lo que de verdad está en el almacén
  const carpeta = `${tarea.owner_id}/${tarea.id}`;
  const recibidas = [];
  for (const f of filas || []) {
    const nombre = f.ruta.split('/').pop();
    const { data: lista, error: errLista } = await sbAdmin().storage.from('entregas').list(carpeta, { search: nombre, limit: 1 });
    if (errLista) throw errLista;
    if (lista?.some((o) => o.name === nombre)) recibidas.push(f.id);
  }
  if (recibidas.length) {
    const { error: errUpd } = await sbAdmin().from('entregas').update({ estado: 'pendiente' }).in('id', recibidas);
    if (errUpd) throw errUpd;
  }
  return res.status(200).json({ recibidas: recibidas.length, total: ids.length });
}

export default async function handler(req, res) {
  if (prepararRespuesta(req, res, 'GET, POST')) return;
  try {
    if (req.method === 'GET') return await info(req, res);
    const body = req.body ?? {};
    if (body.accion === 'preparar') return await preparar(body, res);
    if (body.accion === 'confirmar') return await confirmar(body, res);
    throw new ErrorHttp(400, 'Acción no válida.');
  } catch (error) {
    return responderError(res, error, 'entrega');
  }
}
