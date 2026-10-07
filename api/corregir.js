import Anthropic from '@anthropic-ai/sdk';
import {
  ErrorHttp, prepararRespuesta, registrarUso, responderError, sbAdmin, usuarioDeLaPeticion,
} from '../lib/servidor.js';

const client = new Anthropic();
const MODELO = 'claude-sonnet-5';

const CURSOS_VALIDOS = ['1PRI', '2PRI', '3PRI', '4PRI', '5PRI', '6PRI', '1ESO', '2ESO', '3ESO', '4ESO'];
const TIPOS_ARCHIVO_VALIDOS = ['pdf', 'jpeg', 'jpg', 'png', 'gif', 'webp'];

const SYSTEM_PROMPT = `Eres un profesor/a corrector/a de tareas de alumnos de Primaria y ESO en España. \
Tu misión es evaluar el trabajo del alumno según la rúbrica proporcionada y ofrecer un feedback \
constructivo, detallado y motivador, adaptado a su edad y nivel. Tu corrección es una propuesta: \
el profesor la revisará antes de que llegue al alumno.

Directrices:
- Sé justo/a y riguroso/a: aplica la rúbrica con criterio
- Adapta el lenguaje a la edad: 1PRI-2PRI (6-7 años), 3PRI-4PRI (8-9), 5PRI-6PRI (10-11), 1ESO-2ESO (12-13), 3ESO-4ESO (14-15)
- En el comentario, cita partes concretas del trabajo del alumno. No inventes citas: si no puedes leer bien el trabajo \
(foto borrosa, letra ilegible, páginas cortadas), dilo claramente en el comentario
- Las propuestas de mejora deben ser específicas, accionables y ordenadas por importancia
- El mensaje motivador debe ser auténtico, cálido y realista — evita frases vacías

Escala de calificaciones:
- Sobresaliente: 9.0 - 10
- Notable: 7.0 - 8.9
- Bien: 6.0 - 6.9
- Suficiente: 5.0 - 5.9
- Insuficiente: 0 - 4.9`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    nota: {
      type: 'number',
      description: 'Nota numérica entre 0 y 10, con un decimal de precisión',
    },
    nota_texto: {
      type: 'string',
      enum: ['Sobresaliente', 'Notable', 'Bien', 'Suficiente', 'Insuficiente'],
    },
    comentario: {
      type: 'string',
      description:
        'Análisis detallado del trabajo según cada criterio de la rúbrica. ' +
        'Menciona aciertos y puntos débiles con ejemplos concretos del trabajo.',
    },
    propuestas_mejora: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exactamente 3 propuestas de mejora concretas y accionables',
    },
    mensaje_motivador: {
      type: 'string',
      description:
        'Mensaje breve (2-3 frases) dirigido directamente al alumno, cálido y adaptado a su edad.',
    },
    legible: {
      type: 'boolean',
      description: 'false si no se ha podido leer bien el trabajo (foto borrosa, ilegible, incompleta)',
    },
  },
  required: ['nota', 'nota_texto', 'comentario', 'propuestas_mejora', 'mensaje_motivador', 'legible'],
  additionalProperties: false,
};

export default async function handler(req, res) {
  if (prepararRespuesta(req, res)) return;

  let user = null;
  let creditoConsumido = false;

  try {
    user = await usuarioDeLaPeticion(req);

    const body = req.body ?? {};
    const { texto_tarea, archivo_base64, tipo_archivo, nombre_alumno, curso, nombre_tarea, rubrica } = body;

    const camposFaltantes = ['nombre_alumno', 'curso', 'nombre_tarea', 'rubrica']
      .filter((campo) => !body[campo] || String(body[campo]).trim() === '');
    if (camposFaltantes.length > 0) {
      throw new ErrorHttp(400, `Faltan campos obligatorios: ${camposFaltantes.join(', ')}`);
    }

    // Límites para que una sola corrección no cueste mucho más de lo que se cobra
    const LIMITES = { nombre_alumno: 120, nombre_tarea: 200, rubrica: 6000, texto_tarea: 40000 };
    const demasiadoLargo = Object.entries(LIMITES).find(([campo, max]) => String(body[campo] ?? '').length > max);
    if (demasiadoLargo) {
      throw new ErrorHttp(400, `El campo "${demasiadoLargo[0]}" es demasiado largo (máximo ${demasiadoLargo[1]} caracteres).`);
    }

    const tieneTexto = texto_tarea && String(texto_tarea).trim() !== '';
    const tieneArchivo = archivo_base64 && String(archivo_base64).trim() !== '';
    if (!tieneTexto && !tieneArchivo) {
      throw new ErrorHttp(400, 'Debes enviar texto_tarea o archivo_base64 (con tipo_archivo).');
    }
    if (tieneArchivo && !TIPOS_ARCHIVO_VALIDOS.includes(tipo_archivo)) {
      throw new ErrorHttp(400, `El campo "tipo_archivo" debe ser uno de: ${TIPOS_ARCHIVO_VALIDOS.join(', ')}`);
    }
    if (!CURSOS_VALIDOS.includes(curso)) {
      throw new ErrorHttp(400, `El campo "curso" debe ser uno de: ${CURSOS_VALIDOS.join(', ')}`);
    }

    // Cobrar antes de llamar a la IA; se devuelve si algo falla.
    const { data: restantes, error: errCredito } = await sbAdmin().rpc('consumir_credito', { p_user: user.id });
    if (errCredito) throw errCredito;
    if (restantes === null) {
      throw new ErrorHttp(402, 'No te quedan correcciones. Compra un bono para seguir.', 'SIN_CREDITOS');
    }
    creditoConsumido = true;

    // Bloque estable para toda la clase (tarea + rúbrica): va primero y se cachea.
    // Lo que cambia por alumno va detrás, para no romper el prefijo cacheado.
    const bloqueRubrica = {
      type: 'text',
      text:
        `**Nombre de la tarea:** ${nombre_tarea}\n` +
        `**Curso:** ${curso}\n\n` +
        `**Rúbrica de corrección:**\n${rubrica}`,
      cache_control: { type: 'ephemeral' },
    };
    const bloqueAlumno = { type: 'text', text: `Corrige la tarea de **${nombre_alumno}**. Su trabajo:` };

    let bloqueTrabajo;
    if (tieneArchivo) {
      bloqueTrabajo = tipo_archivo === 'pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: archivo_base64 } }
        : {
            type: 'image',
            source: {
              type: 'base64',
              media_type: tipo_archivo === 'jpg' ? 'image/jpeg' : `image/${tipo_archivo}`,
              data: archivo_base64,
            },
          };
    } else {
      bloqueTrabajo = { type: 'text', text: String(texto_tarea) };
    }

    const response = await client.messages.create({
      model: MODELO,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      messages: [{ role: 'user', content: [bloqueRubrica, bloqueAlumno, bloqueTrabajo] }],
    });

    if (response.stop_reason === 'refusal') {
      throw new ErrorHttp(422, 'El modelo no pudo procesar esta corrección. Revisa el contenido enviado.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ErrorHttp(502, 'La corrección salió demasiado larga y se cortó. Inténtalo de nuevo.');
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('Respuesta inesperada del modelo: sin bloque de texto');
    const resultado = JSON.parse(textBlock.text);

    await registrarUso(user.id, 'correccion', MODELO, response.usage, true);
    return res.status(200).json({ ...resultado, creditos_restantes: restantes });
  } catch (error) {
    if (creditoConsumido) {
      const { error: errDevolucion } = await sbAdmin().rpc('devolver_credito', { p_user: user.id });
      if (errDevolucion) console.error('[corregir] No se pudo devolver el crédito:', errDevolucion.message);
      await registrarUso(user.id, 'correccion', MODELO, null, false);
    }

    if (error instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Demasiadas correcciones a la vez. Espera unos segundos.' });
    }
    if (error instanceof Anthropic.BadRequestError) {
      console.error('[corregir] BadRequest:', error.message);
      return res.status(400).json({ error: 'El archivo no se pudo procesar (¿formato o tamaño?).' });
    }
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('[corregir] Clave de Anthropic inválida');
      return res.status(500).json({ error: 'Error de configuración del servidor.' });
    }
    return responderError(res, error, 'corregir');
  }
}
