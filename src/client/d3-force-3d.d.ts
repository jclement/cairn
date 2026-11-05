// d3-force-3d ships no types; force-graph uses it, we add gravity and collision.
declare module "d3-force-3d" {
  interface Force {
    (alpha: number): void;
    strength(s: number): Force;
  }
  export function forceX(x?: number): Force;
  export function forceY(y?: number): Force;
  // biome-ignore lint/suspicious/noExplicitAny: node type is the caller's
  export function forceCollide(radius?: number | ((node: any) => number)): Force;
}
