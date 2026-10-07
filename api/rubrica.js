// Genera una rúbrica a partir de una descripción corta de la tarea. No consume créditos.
import Anthropic from '@anthropic-ai/sdk';
import {
  ErrorHttp, prepararRespuesta, registrarUso, responderError, usoReciente, usuarioDeLaPeticion,
} from '../lib/servidor.js';

const client = new Anthropic();
const MODELO = 'claude-sonnet-5';
const MAX_POR_HORA = 20;

const SYSTEM_PROMPT = `Eres un docente experto en evaluación de Primaria y ESO en España. \
Escribes rúbricas de corrección claras, breves y aplicables, alineadas con los criterios de evaluación de la LOMLOE.

Formato de la rúbrica:
- Entre 3 y 5 criterios, cada uno en una línea: "- Nombre del criterio (X pts): qué se valora"
- Los puntos suman 10
- Lenguaje sencillo, sin jerga
- Al final, una línea "Penalizaciones:" solo si procede (ortografía, entrega incompleta...)`;

export default async function handler(req, res) {
  if (prepararRespuesta(req, res)) return;
  try {
    const user = await usuarioDeLaPeticion(req);
    const { descripcion, curso } = req.body ?? {};
    if (!descripcion || String(descripcion).trim().length < 5) {
      throw new ErrorHttp(400, 'Describe la tarea en una frase para poder proponer una rúbrica.');
    }
    if (await usoReciente(user.id, 'rubrica', 60) >= MAX_POR_HORA) {
      throw new ErrorHttp(429, 'Has generado muchas rúbricas en la última hora. Inténtalo más tarde.');
    }

    const response = await client.messages.create({
      model: MODELO,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { rubrica: { type: 'string' } },
            required: ['rubrica'],
            additionalProperties: false,
          },
        },
      },
      messages: [{
        role: 'user',
        content: `Curso: ${curso || 'sin especificar'}\nTarea: ${String(descripcion).slice(0, 2000)}`,
      }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (response.stop_reason === 'refusal' || !textBlock) {
      throw new ErrorHttp(422, 'No se pudo generar la rúbrica. Prueba a describir la tarea de otra forma.');
    }
    await registrarUso(user.id, 'rubrica', MODELO, response.usage, true);
    return res.status(200).json(JSON.parse(textBlock.text));
  } catch (error) {
    return responderError(res, error, 'rubrica');
  }
}
