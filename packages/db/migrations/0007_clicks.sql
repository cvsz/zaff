-- migrate:up
CREATE TABLE clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES affiliate_links(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  clicked_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text,
  user_agent text,
  referer text,
  country_hint text
);

CREATE INDEX idx_clicks_link_clicked_at ON clicks (link_id, clicked_at DESC);

CREATE INDEX idx_clicks_org_clicked_at ON clicks (org_id, clicked_at DESC);

-- migrate:down
DROP TABLE IF EXISTS clicks;
