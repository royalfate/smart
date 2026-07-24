const photoKey = (item) =>
  item.photoId ||
  `${item.imageUrl || item.image || item.src || ""}|${item.date || ""}|${item.desc || item.description || ""}`;

export function normalizePhoto(item = {}, includeInSheet = false, index = 0) {
  const imageUrl = item.imageUrl || item.image || item.src || "";
  if (!imageUrl) return null;
  return {
    ...item,
    photoId: item.photoId || `legacy_${index}_${Math.abs(hashString(photoKey(item)))}`,
    imageUrl,
    date: String(item.date || "").slice(0, 10),
    desc: item.desc || item.description || "",
    includeInSheet: Boolean(item.includeInSheet ?? includeInSheet),
  };
}

export function mergePhotoCollections(collections = []) {
  const merged = new Map();
  collections.flat().forEach((raw, index) => {
    const item = normalizePhoto(raw, Boolean(raw?.includeInSheet), index);
    if (!item) return;
    const key = raw?.photoId || `${item.imageUrl}|${item.date || ""}|${item.desc || ""}`;
    const prior = merged.get(key);
    merged.set(key, prior
      ? { ...prior, ...item, includeInSheet: Boolean(prior.includeInSheet || item.includeInSheet) }
      : item);
  });
  return [...merged.values()].sort((a, b) =>
    `${a.date || ""}|${a.photoId}`.localeCompare(`${b.date || ""}|${b.photoId}`));
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}
