-- Purpose-specific imagery for the curated Premier League market bundle.
-- Existing imported events are updated only when they still use the generic league mark.

UPDATE market_catalog
SET image_url = CASE id
  WHEN 'pl-2026-27-winner' THEN '/catalog-images/pl-winner.jpg'
  WHEN 'pl-2026-27-golden-boot' THEN '/catalog-images/pl-golden-boot.jpg'
  WHEN 'pl-2026-27-most-assists' THEN '/catalog-images/pl-most-assists.jpg'
  WHEN 'pl-2026-27-golden-glove' THEN '/catalog-images/pl-golden-glove.jpg'
  WHEN 'pl-2026-27-highest-promoted-club' THEN '/catalog-images/pl-promoted-clubs.jpg'
  WHEN 'pl-2026-27-any-promoted-survives' THEN '/catalog-images/pl-promoted-survival.jpg'
  WHEN 'pl-2026-27-champion-over-89-5' THEN '/catalog-images/pl-champion-points.jpg'
  WHEN 'pl-2026-27-arsenal-top-five' THEN '/catalog-images/arsenal-top-five.png'
  WHEN 'pl-2026-27-man-utd-top-five' THEN '/catalog-images/manchester-united-top-five.png'
  WHEN 'pl-2026-27-chelsea-vs-spurs' THEN '/catalog-images/chelsea-vs-spurs.png'
  WHEN 'pl-2026-27-first-manager-to-leave' THEN '/catalog-images/pl-first-manager.jpg'
  WHEN 'pl-2026-27-highest-scoring-club' THEN '/catalog-images/pl-highest-scoring.jpg'
  ELSE image_url
END,
updated_at = now()
WHERE id IN (
  'pl-2026-27-winner',
  'pl-2026-27-golden-boot',
  'pl-2026-27-most-assists',
  'pl-2026-27-golden-glove',
  'pl-2026-27-highest-promoted-club',
  'pl-2026-27-any-promoted-survives',
  'pl-2026-27-champion-over-89-5',
  'pl-2026-27-arsenal-top-five',
  'pl-2026-27-man-utd-top-five',
  'pl-2026-27-chelsea-vs-spurs',
  'pl-2026-27-first-manager-to-leave',
  'pl-2026-27-highest-scoring-club'
);

UPDATE market_events
SET image_url = catalog.image_url
FROM market_catalog AS catalog
WHERE market_events.catalog_market_id = catalog.id
  AND catalog.id LIKE 'pl-2026-27-%'
  AND (
    market_events.image_url IS NULL
    OR market_events.image_url = ''
    OR market_events.image_url = '/league-logos/premier-league-dark.png'
  );
