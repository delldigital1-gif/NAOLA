// Initie le paiement de l'abonnement Dell Digital pour une entreprise directe
// ou un cabinet (Enterprise = sur devis, exclu du self-serve). Nécessite un
// JWT valide (verify_jwt=true). Mode sandbox tant que CINETPAY_API_KEY n'est
// pas configuré sur ce projet.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const PRICES_FCFA: Record<string, Record<string, number>> = {
  company: { Starter: 15000, Business: 35000 },
  cabinet: { 'Cabinet Starter': 50000, 'Cabinet Pro': 120000 },
};
const CINETPAY_BASE_URL = 'https://api-checkout.cinetpay.com/v2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Unauthorized' }, 401);

  let body: { ownerType?: string; plan?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const ownerType = body.ownerType;
  if (ownerType !== 'company' && ownerType !== 'cabinet') {
    return json({ error: "ownerType invalide — 'company' ou 'cabinet'" }, 400);
  }

  const plan = body.plan;
  const amount = plan ? PRICES_FCFA[ownerType][plan] : undefined;
  if (!plan || !amount) {
    return json({ error: 'Plan invalide pour ce type de compte (Enterprise = sur devis, nous contacter)' }, 400);
  }

  let ownerId: string, ownerName: string, refAffilie: string | null;
  if (ownerType === 'company') {
    const { data: owner } = await userClient
      .from('companies').select('id, name, ref_affilie').eq('owner_auth_id', user.id).maybeSingle();
    if (!owner) return json({ error: 'Entreprise introuvable pour ce compte' }, 404);
    ownerId = owner.id; ownerName = owner.name; refAffilie = owner.ref_affilie;
  } else {
    const { data: owner } = await userClient
      .from('cabinets').select('id, name, ref_affilie').eq('admin_auth_id', user.id).maybeSingle();
    if (!owner) return json({ error: 'Cabinet introuvable pour ce compte' }, 404);
    ownerId = owner.id; ownerName = owner.name; refAffilie = owner.ref_affilie;
  }

  const serviceClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const transactionId = `DDN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  await serviceClient.from('subscription_payments').insert({
    owner_type: ownerType,
    owner_id: ownerId,
    plan,
    amount_fcfa: amount,
    transaction_id: transactionId,
    statut: 'En attente',
    ref_affilie: refAffilie,
  });

  const cinetpayKey = Deno.env.get('CINETPAY_API_KEY');
  if (!cinetpayKey) {
    return json({
      transaction_id: transactionId,
      url_paiement: `https://checkout.cinetpay.com/demo/${transactionId}`,
      montant: amount,
      mode: 'sandbox',
    });
  }

  try {
    const resp = await fetch(`${CINETPAY_BASE_URL}/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: cinetpayKey,
        site_id: Deno.env.get('CINETPAY_SITE_ID'),
        amount,
        currency: 'XOF',
        transaction_id: transactionId,
        description: `Abonnement NAOLA ${plan} — ${ownerName}`,
        return_url: `https://naoladigital-rh.com/?transaction_id=${transactionId}`,
        notify_url: `${supabaseUrl}/functions/v1/confirmer-paiement-abonnement`,
        customer_name: ownerName,
        customer_email: Deno.env.get('DELLDIGITAL_EMAIL') || 'delldigital1@gmail.com',
        channels: 'ALL',
        lang: 'fr',
      }),
    });
    const data = await resp.json();
    if (data.code !== '201') {
      return json({
        transaction_id: transactionId, url_paiement: '', montant: amount,
        erreur: data.message || data.description || 'Réponse CinetPay inattendue',
      });
    }
    return json({
      transaction_id: transactionId,
      url_paiement: data.data?.payment_url || '',
      montant: amount,
      mode: 'production',
    });
  } catch (e) {
    return json({ transaction_id: transactionId, url_paiement: '', montant: amount, erreur: String(e) });
  }
});
