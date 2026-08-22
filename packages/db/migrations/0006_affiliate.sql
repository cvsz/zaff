-- migrate:up
-- Shared disposable dev databases may hold orphaned affiliate tables whose
-- schema_migrations rows were wiped by test schema resets (FK cascade drops
-- the constraint, not the referencing table). Drop any orphans first so the
-- bare CREATE below always applies cleanly. Kept as one statement: this
-- container's per-statement latency makes multi-statement guards measurably
-- slower inside the shared-DB test suites.
DROP TABLE IF EXISTS conversions,
  affiliate_links,
  campaigns,
  offers,
  products,
  merchants,
  affiliate_providers;

CREATE TABLE affiliate_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]',
  last_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  provider_id uuid NOT NULL REFERENCES affiliate_providers(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, external_id)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  merchant_id uuid REFERENCES merchants(id) ON DELETE SET NULL,
  external_id text,
  title text NOT NULL,
  description text,
  price_amount numeric(12,2) NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'evaluated', 'selected', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_products_org_merchant_external
  ON products (org_id, merchant_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX idx_products_org_status ON products (org_id, status);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url text NOT NULL,
  commission_type text NOT NULL CHECK (commission_type IN ('percentage', 'fixed')),
  commission_value numeric(12,4) NOT NULL,
  promotion_label text,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
  objective text,
  budget_limit numeric(12,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE affiliate_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  offer_id uuid REFERENCES offers(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  target_url text NOT NULL,
  utm jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  link_id uuid REFERENCES affiliate_links(id) ON DELETE SET NULL,
  external_order_id text NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  commission_amount numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'refunded', 'rejected')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_conversions_link_external_order
  ON conversions (link_id, external_order_id)
  WHERE link_id IS NOT NULL;

CREATE INDEX idx_conversions_org_occurred_at ON conversions (org_id, occurred_at DESC);

-- migrate:down
DROP TABLE IF EXISTS conversions,
  affiliate_links,
  campaigns,
  offers,
  products,
  merchants,
  affiliate_providers;
