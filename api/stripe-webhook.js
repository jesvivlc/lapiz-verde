// Stripe avisa aquí cuando un pago se completa. Suma los créditos una sola vez por sesión.
import Stripe from 'stripe';
import { sbAdmin } from '../lib/servidor.js';

// La firma se verifica sobre el cuerpo sin procesar
export const config = { api: { bodyParser: false } };

async function cuerpoSinProcesar(req) {
  const trozos = [];
  for await (const trozo of req) trozos.push(typeof trozo === 'string' ? Buffer.from(trozo) : trozo);
  return Buffer.concat(trozos);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Pagos sin configurar' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let evento;
  try {
    evento = stripe.webhooks.constructEvent(
      await cuerpoSinProcesar(req),
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (e) {
    console.error('[stripe-webhook] Firma no válida:', e.message);
    return res.status(400).json({ error: 'Firma no válida' });
  }

  if (evento.type === 'checkout.session.completed' || evento.type === 'checkout.session.async_payment_succeeded') {
    const sesion = evento.data.object;
    if (sesion.payment_status !== 'paid') return res.status(200).json({ recibido: true, pendiente: true });

    const userId = sesion.metadata?.user_id || sesion.client_reference_id;
    const creditos = parseInt(sesion.metadata?.creditos, 10);
    if (!userId || !creditos) {
      console.error('[stripe-webhook] Sesión sin metadatos:', sesion.id);
      return res.status(200).json({ recibido: true, ignorado: true });
    }

    const { data: nuevo, error } = await sbAdmin().rpc('acreditar_pago', {
      p_session: sesion.id,
      p_user: userId,
      p_creditos: creditos,
      p_importe: sesion.amount_total ?? null,
    });
    if (error) {
      // 500 → Stripe reintentará más tarde
      console.error('[stripe-webhook] Error acreditando:', error.message);
      return res.status(500).json({ error: 'No se pudo acreditar' });
    }
    return res.status(200).json({ recibido: true, acreditado: nuevo });
  }

  return res.status(200).json({ recibido: true });
}
