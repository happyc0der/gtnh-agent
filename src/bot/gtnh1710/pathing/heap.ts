/**
 * The search's open list: a binary min-heap of node indices by key, with each node's place in
 * the heap kept so a node found again more cheaply moves up instead of being pushed twice
 * (decrease-key, as Baritone's BinaryHeapOpenSet does). Typed arrays, no objects per node. Pure.
 */
export class NodeHeap {
  #nodes: Int32Array;
  #keys: Float64Array;
  #size = 0;
  /** Per node: its index in the heap + 1, 0 when not in it. */
  readonly #slot: Int32Array;

  constructor(nodeCount: number, capacity = 1024) {
    this.#nodes = new Int32Array(capacity);
    this.#keys = new Float64Array(capacity);
    this.#slot = new Int32Array(nodeCount);
  }

  get size(): number {
    return this.#size;
  }

  has(node: number): boolean {
    return (this.#slot[node] as number) !== 0;
  }

  /** Adds `node` with `key`, or lowers its key when it is in the heap already. */
  push(node: number, key: number): void {
    const slot = this.#slot[node] as number;
    if (slot !== 0) {
      if (key < (this.#keys[slot - 1] as number)) this.#up(slot - 1, node, key);
      return;
    }
    if (this.#size === this.#nodes.length) this.#grow();
    this.#up(this.#size++, node, key);
  }

  /** Removes and returns the node with the lowest key (-1 when empty). */
  pop(): number {
    if (this.#size === 0) return -1;
    const top = this.#nodes[0] as number;
    this.#slot[top] = 0;
    const last = --this.#size;
    if (last > 0) this.#down(0, this.#nodes[last] as number, this.#keys[last] as number);
    return top;
  }

  #up(at: number, node: number, key: number): void {
    const nodes = this.#nodes;
    const keys = this.#keys;
    let i = at;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pk = keys[parent] as number;
      if (pk <= key) break;
      const pn = nodes[parent] as number;
      nodes[i] = pn;
      keys[i] = pk;
      this.#slot[pn] = i + 1;
      i = parent;
    }
    nodes[i] = node;
    keys[i] = key;
    this.#slot[node] = i + 1;
  }

  #down(at: number, node: number, key: number): void {
    const nodes = this.#nodes;
    const keys = this.#keys;
    const size = this.#size;
    let i = at;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= size) break;
      const right = left + 1;
      const child = right < size && (keys[right] as number) < (keys[left] as number) ? right : left;
      const ck = keys[child] as number;
      if (ck >= key) break;
      const cn = nodes[child] as number;
      nodes[i] = cn;
      keys[i] = ck;
      this.#slot[cn] = i + 1;
      i = child;
    }
    nodes[i] = node;
    keys[i] = key;
    this.#slot[node] = i + 1;
  }

  #grow(): void {
    const nodes = new Int32Array(this.#nodes.length * 2);
    nodes.set(this.#nodes);
    const keys = new Float64Array(this.#keys.length * 2);
    keys.set(this.#keys);
    this.#nodes = nodes;
    this.#keys = keys;
  }
}
