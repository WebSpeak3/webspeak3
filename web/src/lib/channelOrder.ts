/** Minimal shape needed to lay channels out like the channel tree. */
export interface OrderedChannelLike {
  id: number;
  parent: number;
  /** Position among the siblings of the same parent (not a global index). */
  order: number;
}

/**
 * Flattens channels in channel-tree order: each parent is followed by its
 * subchannels (recursively), siblings sorted by `order`. `order` is only
 * meaningful between siblings, so a flat sort by it interleaves the levels.
 * Channels whose parent is missing are appended at the end as roots.
 */
export function channelsInTreeOrder<T extends OrderedChannelLike>(
  channels: readonly T[],
): { channel: T; depth: number }[] {
  const byParent = new Map<number, T[]>();
  for (const ch of channels) {
    const list = byParent.get(ch.parent);
    if (list) list.push(ch);
    else byParent.set(ch.parent, [ch]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order || a.id - b.id);

  const out: { channel: T; depth: number }[] = [];
  const seen = new Set<number>();
  const walk = (parent: number, depth: number) => {
    for (const ch of byParent.get(parent) ?? []) {
      if (seen.has(ch.id)) continue;
      seen.add(ch.id);
      out.push({ channel: ch, depth });
      walk(ch.id, depth + 1);
    }
  };
  walk(0, 0);
  // Orphans (parent not in the list) and anything in a parent cycle.
  for (const ch of channels) {
    if (seen.has(ch.id)) continue;
    const orphanParent = ch.parent;
    for (const sibling of byParent.get(orphanParent) ?? []) {
      if (seen.has(sibling.id)) continue;
      seen.add(sibling.id);
      out.push({ channel: sibling, depth: 0 });
      walk(sibling.id, 1);
    }
  }
  return out;
}
