// Corrige lo que un alumno ha entregado por enlace o por correo (archivos en el almacén).
// Cobra 1 corrección por alumno; si falla, la devuelve. La propuesta se guarda en
// `entregas.resultado` hasta que el profesor la aprueba.
import Anthropic from '@anthropic-ai/sdk';
import {
  ErrorHttp, prepararRespuesta, registrarUso, responderError, sbAdmin, usuarioDeLaPeticion,
} from '../lib/servidor.js';
import {
  CURSOS_VALIDOS, FALLOS_COBRADOS, MODELO, cobrarCredito, devolverCredito, leerCorreccion, peticionCorreccion, responderErrorIA,
} from '../lib/correccion.js';
import { archivosDelAlumno, guardarCorreccion, marcarError, nombreCompleto, trabajoDeArchivos } from '../lib/entregas.js';

const client = new Anthropic();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (prepararRespuesta(req, res)) return;

  let user = null;
  let creditoConsumido = false;
  let ids = [];

  try {
    user = await usuarioDeLaPeticion(req);
    const { tarea_id, alumno_id, curso, rubrica } = req.body ?? {};
    if (!UUID.test(String(tarea_id ?? '')) || !UUID.test(String(alumno_id ?? ''))) {
      throw new ErrorHttp(400, 'Faltan la tarea o el alumno.');
    }
    if (!rubrica || !String(rubrica).trim()) throw new ErrorHttp(400, 'Falta la rúbrica.');
    if (String(rubrica).length > 6000) throw new ErrorHttp(400, 'La rúbrica es demasiado larga (máximo 6000 caracteres).');
    if (!CURSOS_VALIDOS.includes(curso)) {
      throw new ErrorHttp(400, `El campo "curso" debe ser uno de: ${CURSOS_VALIDOS.join(', ')}`);
    }

    // Tarea y alumno, solo si son de este profesor y del mismo grupo
    const { data: tarea, error: errTarea } = await sbAdmin().from('tareas')
      .select('id,titulo,grupo_id').eq('id', tarea_id).eq('owner_id', user.id).maybeSingle();
    if (errTarea) throw errTarea;
    if (!tarea) throw new ErrorHttp(404, 'Tarea no encontrada.');
    const { data: alumno, error: errAlumno } = await sbAdmin().from('alumnos')
      .select('id,nombre,apellidos').eq('id', alumno_id).eq('owner_id', user.id).eq('grupo_id', tarea.grupo_id).maybeSingle();
    if (errAlumno) throw errAlumno;
    if (!alumno) throw new ErrorHttp(404, 'Alumno no encontrado en el grupo de la tarea.');

    const filas = await archivosDelAlumno(tarea.id, alumno.id);
    if (!filas.length) throw new ErrorHttp(404, 'Este alumno no tiene entregas pendientes.');
    ids = filas.map((f) => f.id);
    const trabajo = await trabajoDeArchivos(filas);
    if (!trabajo.length) throw new ErrorHttp(400, 'Los archivos entregados no son PDF ni fotos.');

    const restantes = await cobrarCredito(user.id);
    creditoConsumido = true;

    const response = await client.messages.create(peticionCorreccion({
      nombre_alumno: nombreCompleto(alumno), curso, nombre_tarea: tarea.titulo, rubrica: String(rubrica), trabajo,
    }));
    await registrarUso(user.id, 'correccion', MODELO, response.usage, true);
    if (['refusal', 'max_tokens'].includes(response.stop_reason)) creditoConsumido = false;   // la IA trabajó: no se devuelve
    const resultado = leerCorreccion(response);
    await guardarCorreccion(ids, resultado);
    return res.status(200).json({ ...resultado, creditos_restantes: restantes, entregas: ids });
  } catch (error) {
    if (creditoConsumido) {
      await devolverCredito(user.id, 'corregir-entregas');
      await registrarUso(user.id, 'correccion', MODELO, null, false);
    }
    // Solo se marca como error si la IA falló; un error de datos no estropea la entrega
    if (ids.length && (creditoConsumido || FALLOS_COBRADOS.includes(error?.codigo))) {
      await marcarError(ids, error?.message ?? 'Error al corregir');
    }
    if (responderErrorIA(res, error, 'corregir-entregas')) return;
    return responderError(res, error, 'corregir-entregas');
  }
}
