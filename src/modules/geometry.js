const earthRadiusMeters = 6371008.8;

function ringArea(ring) {
  let total = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    total += (next[0] - current[0]) * Math.PI / 180
      * (2 + Math.sin(current[1] * Math.PI / 180) + Math.sin(next[1] * Math.PI / 180));
  }
  return Math.abs(total * earthRadiusMeters ** 2 / 2);
}

export function geodesicArea(geometry) {
  if (!geometry || geometry.type === 'Point') return 0;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((area, rings) => area + rings.reduce(
    (polygonArea, ring, index) => polygonArea + (index === 0 ? 1 : -1) * ringArea(ring),
    0,
  ), 0);
}

export function normalizeGeometry(value) {
  if (value?.type === 'Feature') return value.geometry;
  return value;
}

export function parseGeoJson(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const features = parsed?.type === 'FeatureCollection'
    ? parsed.features
    : parsed?.type === 'Feature'
      ? [parsed]
      : [{ type: 'Feature', geometry: parsed, properties: {} }];
  return features.filter((feature) => feature?.geometry);
}
