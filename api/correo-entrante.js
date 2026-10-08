// Buzón de correo por grupo: el alumno envía su trabajo a <buzon>@entregas.lapizverde.com,
// Resend lo recibe y nos avisa (webhook «email.received»). Aquí se guardan los adjuntos
// como entregas: del alumno si su correo está en la lista, «sin identificar» si no.
import crypto from 'node:crypto';
import { cuerpoSinProcesar, sbAdmin } from '../lib/servidor.js';
import { MAX_ARCHIVOS } from '../lib/correccion.js';

export const config = { api: { bodyParser: false } };

const DOMINIO = (process.env.DOMINIO_ENTREGAS || 'entregas.lapizverde.com').toLowerCase();
const BUZON_VALIDO = /^[a-z0-9-]{12,48}$/;
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_POR_HORA = 300;           // adjuntos por profesor y hora por correo
const EXTENSION = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Firma de Svix (la que usa Resend): HMAC-SHA256 de "id.timestamp.cuerpo" con el secreto whsec_… */
export function firmaValida(cuerpo, cabeceras, secreto, ahora = Date.now()) {
  const id = cabeceras['svix-id'];
  const ts = cabeceras['svix-timestamp'];
  const firmas = cabeceras['svix-signature'];
  if (!id || !ts || !firmas) return false;
  if (Math.abs(ahora / 1000 - Number(ts)) > 300) return false;   // más de 5 minutos: posible reenvío
  const clave = Buffer.from(String(secreto).replace(/^whsec_/, ''), 'base64');
  const esperada = Buffer.from(crypto.createHmac('sha256', clave).update(`${id}.${ts}.${cuerpo}`).digest('base64'));
  return String(firmas).split(' ').some((f) => {
    const [version, firma] = f.split(',');
    const recibida = Buffer.from(firma ?? '');
    return version === 'v1' && recibida.length === esperada.length && crypto.timingSafeEqual(recibida, esperada);
  });
}

/** "Ana López <ana@x.es>" → "ana@x.es" */
export function direccion(texto) {
  const m = String(texto ?? '').match(/<([^>]+)>/);
  return (m ? m[1] : String(texto ?? '')).trim().toLowerCase();
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** La tarea cuyo título aparece en el asunto (la de título más largo); si no, la última con la entrega abierta.
    Si la entrega de esa tarea está cerrada, no se acepta: cerrar la entrega cierra también el buzón. */
export function elegirTarea(tareas, asunto) {
  const a = norm(asunto);
  const enAsunto = tareas.filter((t) => t.titulo && a.includes(norm(t.titulo)))
    .sort((x, y) => y.titulo.length - x.titulo.length);
  const tarea = enAsunto[0] ?? tareas.find((t) => t.entrega_abierta) ?? null;
  return tarea?.entrega_abierta ? tarea : null;
}

async function resend(ruta) {
  const resp = await fetch(`https://api.resend.com${ruta}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
  if (!resp.ok) throw new Error(`Resend ${resp.status} en ${ruta}`);
  return resp.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!process.env.RESEND_WEBHOOK_SECRET || !process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: 'Buzón sin configurar' });
  }
  const cuerpo = (await cuerpoSinProcesar(req)).toString('utf8');
  if (!firmaValida(cuerpo, req.headers, process.env.RESEND_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Firma no válida' });
  }

  // A partir de aquí se responde 200 aunque se ignore el correo: si no, Resend lo reintenta
  let correoApuntado = null;
  try {
    const evento = JSON.parse(cuerpo);
    if (evento.type !== 'email.received') return res.status(200).json({ ignorado: 'otro evento' });
    const { email_id: correoId, from, subject } = evento.data ?? {};
    const para = [].concat(evento.data?.to ?? []).map(direccion);
    const buzon = para.find((d) => d.endsWith('@' + DOMINIO))?.split('@')[0];
    if (!correoId || !buzon || !BUZON_VALIDO.test(buzon)) return res.status(200).json({ ignorado: 'sin buzón' });

    const { data: grupo, error: errGrupo } = await sbAdmin().from('grupos').select('id,owner_id').eq('buzon', buzon).maybeSingle();
    if (errGrupo) throw errGrupo;
    if (!grupo) return res.status(200).json({ ignorado: 'buzón desconocido' });


    const haceUnaHora = new Date(Date.now() - 3600_000).toISOString();
    const { count: ultimaHora } = await sbAdmin().from('entregas').select('id', { count: 'exact', head: true })
      .eq('owner_id', grupo.owner_id).eq('canal', 'correo').gte('created_at', haceUnaHora);
    if ((ultimaHora ?? 0) >= MAX_POR_HORA) return res.status(200).json({ ignorado: 'demasiados correos' });

    const { data: tareas, error: errTareas } = await sbAdmin().from('tareas')
      .select('id,titulo,entrega_abierta,created_at').eq('grupo_id', grupo.id).order('created_at', { ascending: false });
    if (errTareas) throw errTareas;
    const tarea = elegirTarea(tareas || [], subject);
    if (!tarea) return res.status(200).json({ ignorado: 'ninguna tarea con la entrega abierta' });

    const remitente = direccion(from);
    const { data: alumnos } = await sbAdmin().from('alumnos').select('id,email').eq('grupo_id', grupo.id).eq('activo', true);
    const alumno = (alumnos || []).find((a) => a.email && a.email.trim().toLowerCase() === remitente);

    const { data: adjuntos } = await resend(`/emails/receiving/${encodeURIComponent(correoId)}/attachments`);
    const validos = (adjuntos || [])
      .filter((a) => EXTENSION[a.content_type] && a.size > 0 && a.size <= MAX_BYTES)
      .filter((a) => !(a.content_disposition === 'inline' && a.size < 20_000))   // logos y firmas del correo
      .slice(0, MAX_ARCHIVOS);
    if (!validos.length) return res.status(200).json({ ignorado: 'sin adjuntos válidos' });

    // Se apunta antes de guardar nada: si el aviso llega dos veces a la vez, solo uno pasa
    const { error: errDup } = await sbAdmin().from('correos_procesados').insert({ correo_id: correoId });
    if (errDup) {
      if (errDup.code === '23505') return res.status(200).json({ ignorado: 'ya recibido' });
      throw errDup;
    }
    correoApuntado = correoId;

    let recibidos = 0;
    for (const a of validos) {
      const resp = await fetch(a.download_url);
      if (!resp.ok) continue;
      const datos = Buffer.from(await resp.arrayBuffer());
      if (datos.length > MAX_BYTES) continue;
      const id = crypto.randomUUID();
      const ruta = `${grupo.owner_id}/${tarea.id}/${id}.${EXTENSION[a.content_type]}`;
      const { error: errSubida } = await sbAdmin().storage.from('entregas').upload(ruta, datos, { contentType: a.content_type });
      if (errSubida) throw errSubida;
      const { error: errFila } = await sbAdmin().from('entregas').insert({
        id, owner_id: grupo.owner_id, tarea_id: tarea.id, alumno_id: alumno?.id ?? null, canal: 'correo', ruta,
        nombre_fichero: String(a.filename ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 120),
        mime: a.content_type, bytes: datos.length, remitente: remitente.slice(0, 200), correo_id: correoId, estado: 'pendiente',
      });
      if (errFila) throw errFila;
      recibidos++;
    }
    return res.status(200).json({ recibidos, identificado: !!alumno });
  } catch (error) {
    // Error nuestro (base de datos, almacén): 500 para que Resend lo reintente más tarde
    console.error('[correo-entrante] Error:', error?.message ?? error);
    if (correoApuntado) {
      // Se quita la marca para que el reintento lo procese; lo ya guardado de este correo se deshace
      await sbAdmin().from('entregas').delete().eq('correo_id', correoApuntado);
      await sbAdmin().from('correos_procesados').delete().eq('correo_id', correoApuntado);
    }
    return res.status(500).json({ error: 'Error interno' });
  }
}
