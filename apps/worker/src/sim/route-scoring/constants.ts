// Route-scoring shared constants. Not a binary-named function; hosts the
// cost-infinite sentinel and the stairs-extra-cost offset referenced by
// the per-scorer files in this directory.

export const ROUTE_COST_INFINITE = 0x7fff;
export const STAIRS_ROUTE_EXTRA_COST = 0x280; // 640
