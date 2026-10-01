/**
 * A small reader for Forge 1.7.10 configuration files (`category { B:key=value ... }`,
 * nested categories, quoted keys and `S:key < ... >` lists). Values stay strings.
 */

export interface ConfigCategory {
  values: Map<string, string>;
  lists: Map<string, string[]>;
  children: Map<string, ConfigCategory>;
}

function category(): ConfigCategory {
  return { values: new Map(), lists: new Map(), children: new Map() };
}

const unquote = (s: string): string => {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
};

export function parseForgeConfig(text: string): ConfigCategory {
  const root = category();
  const stack: ConfigCategory[] = [root];
  let list: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (list !== null) {
      if (line === '>') list = null;
      else if (line !== '') list.push(line);
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    const top = stack[stack.length - 1] ?? root;
    if (line.endsWith('{')) {
      const name = unquote(line.slice(0, -1));
      const child = top.children.get(name) ?? category();
      top.children.set(name, child);
      stack.push(child);
      continue;
    }
    if (line === '}') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    // T:key=value  or  T:"key with spaces"=value  or  T:key <
    const m = /^[A-Z]:("(?:[^"]*)"|[^=<]+?)\s*(=|<)\s*(.*)$/.exec(line);
    if (m === null) continue;
    const key = unquote(m[1] ?? '');
    if (m[2] === '<') {
      list = [];
      top.lists.set(key, list);
      if ((m[3] ?? '').trim() === '>') list = null;
    } else top.values.set(key, (m[3] ?? '').trim());
  }
  return root;
}

/** The category at a path of names (null if missing). */
export function categoryAt(root: ConfigCategory, ...path: string[]): ConfigCategory | null {
  let cur: ConfigCategory | undefined = root;
  for (const p of path) {
    cur = cur?.children.get(p);
    if (cur === undefined) return null;
  }
  return cur;
}
