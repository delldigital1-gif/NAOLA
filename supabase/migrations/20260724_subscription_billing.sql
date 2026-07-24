-- Abonnement Dell Digital réel (entreprises directes ET cabinets) — jusqu'ici
-- subscribe()/subscribeCab() activaient le plan instantanément sans paiement.
-- Appliqué via Supabase MCP le 2026-07-24 — ce fichier documente ce qui est
-- en prod, il n'est pas exécuté automatiquement (pas de pipeline de migration
-- ici).

ALTER TABLE companies ADD COLUMN IF NOT EXISTS ref_affilie varchar(20);
ALTER TABLE cabinets ADD COLUMN IF NOT EXISTS ref_affilie varchar(20);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('company','cabinet')),
  owner_id uuid not null,
  plan text not null,
  amount_fcfa numeric not null,
  transaction_id text unique,
  statut text not null default 'En attente',
  ref_affilie varchar(20),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscription_payments_select_own" ON subscription_payments
  FOR SELECT USING (
    (owner_type = 'company' AND owner_id IN (
      SELECT id FROM companies WHERE owner_auth_id = auth.uid()
    ))
    OR (owner_type = 'cabinet' AND owner_id IN (
      SELECT id FROM cabinets WHERE admin_auth_id = auth.uid()
    ))
  );

CREATE POLICY "subscription_payments_service_role" ON subscription_payments
  FOR ALL USING (auth.role() = 'service_role');

-- Secret partagé avec Dell Digital Partner (même valeur que sur le projet
-- unimanage), stocké en Vault faute de CLI Supabase pour secrets Edge Function.
-- select vault.create_secret('<secret>', 'partner_webhook_secret', '...');
CREATE OR REPLACE FUNCTION public.get_partner_webhook_secret()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, vault
AS $$
  select decrypted_secret from vault.decrypted_secrets where name = 'partner_webhook_secret';
$$;

REVOKE ALL ON FUNCTION public.get_partner_webhook_secret() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_webhook_secret() TO service_role;

-- Note : côté projet dell-digital-partner (autre base Supabase), une migration
-- séparée ajoute 'saas_naola' à son enum product_type — voir ce repo-là.
