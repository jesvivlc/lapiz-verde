// Crea una sesión de Stripe Checkout para comprar un bono de correcciones.
import Stripe from 'stripe';
import {
  ErrorHttp, origenDeLaPeticion, prepararRespuesta, responderError, usuarioDeLaPeticion,
} from '../lib/servidor.js';

export const BONOS = {
  '100': { creditos: 100, importe_cents: 900, nombre: 'Bono 100 correcciones' },
  '500': { creditos: 500, importe_cents: 3500, nombre: 'Bono 500 correcciones' },
};

export default async function handler(req, res) {
  if (prepararRespuesta(req, res)) return;
  try {
    const user = await usuarioDeLaPeticion(req);
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new ErrorHttp(503, 'Los pagos todavía no están activados.');
    }
    const bono = BONOS[String(req.body?.bono ?? '100')];
    if (!bono) throw new ErrorHttp(400, 'Bono no válido.');

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const origen = origenDeLaPeticion(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: bono.importe_cents,
          product_data: { name: bono.nombre },
        },
      }],
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: { user_id: user.id, creditos: String(bono.creditos) },
      success_url: `${origen}/?pago=ok`,
      cancel_url: `${origen}/?pago=cancelado`,
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    return responderError(res, error, 'checkout');
  }
}
