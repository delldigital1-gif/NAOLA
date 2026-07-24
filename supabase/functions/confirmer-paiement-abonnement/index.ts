// Webhook CinetPay — confirme le paiement de l'abonnement (entreprise directe
// ou cabinet), active le plan, puis notifie Dell Digital Partner pour créditer
// la commission de l'affilié (produit saas_naola, même pourcentage que
// consultant_ai/saas_unimanage). Pas de JWT (verify_jwt=false) : c'est
// CinetPay qui appelle — on revérifie toujours auprès de CinetPay avant de
// faire confiance (mode sandbox : toujours accepté si CINETPAY_API_KEY n'est
// pas configuré sur ce projet).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CINETPAY_BASE_URL = 'https://api-checkout.cinetpay.com/v2';
const PARTNER_API_URL = 'https://partner.erpdelldigital.com';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function extractTransactionId(req: Request): Promise<string | null> {
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get('transaction_id') ?? url.searchParams.get('cpm_trans_id');
  if (fromQuery) return fromQuery;
  try {
    const body = await req.json();
    return body.transaction_id ?? body.cpm_trans_id ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  const transactionId = await extractTransactionId(req);
  if (!transactionId) return json({ error: 'Missing transaction_id' }, 400);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: payment } = await serviceClient
    .from('subscription_payments').select('*').eq('transaction_id', transactionId).maybeSingle();
  if (!payment) return json({ error: 'Transaction introuvable' }, 404);
  if (payment.statut === 'Confirmé') return json({ received: true, skipped: 'already_processed' });

  const cinetpayKey = Deno.env.get('CINETPAY_API_KEY');
  let accepted = true;
  if (cinetpayKey) {
    try {
      const resp = await fetch(`${CINETPAY_BASE_URL}/payment/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apikey: cinetpayKey,
          site_id: Deno.env.get('CINETPAY_SITE_ID'),
          transaction_id: transactionId,
        }),
      });
      const data = await resp.json();
      accepted = data?.data?.status === 'ACCEPTED';
    } catch {
      accepted = false;
    }
  }

  if (!accepted) {
    await serviceClient.from('subscription_payments').update({ statut: 'Annulé' }).eq('transaction_id', transactionId);
    return json({ received: true, accepted: false });
  }

  await serviceClient
    .from('subscription_payments')
    .update({ statut: 'Confirmé', paid_at: new Date().toISOString() })
    .eq('transaction_id', transactionId);

  const table = payment.owner_type === 'company' ? 'companies' : 'cabinets';
  await serviceClient.from(table).update({ plan: payment.plan }).eq('id', payment.owner_id);

  // Notifie Partner pour créditer la commission — best-effort, isolé pour ne
  // jamais faire échouer la confirmation du paiement elle-même.
  if (payment.ref_affilie) {
    try {
      const { data: secret } = await serviceClient.rpc('get_partner_webhook_secret');
      if (secret) {
        await fetch(`${PARTNER_API_URL}/api/webhooks/external-sale`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
          body: JSON.stringify({
            eventId: transactionId,
            productType: 'saas_naola',
            amountCents: Number(payment.amount_fcfa) * 100,
            currency: 'XOF',
            referralCode: payment.ref_affilie,
            providerTransactionId: transactionId,
            metadata: { owner_type: payment.owner_type, owner_id: payment.owner_id, plan: payment.plan },
          }),
        });
      }
    } catch (e) {
      console.error('Notification Partner échouée:', e);
    }
  }

  return json({ received: true, accepted: true });
});
