/**
 * Just enough of the JVM's file formats to read GTNH's data tables straight out of its jars:
 * a jar (zip) reader, a class-file parser, and a symbolic interpreter for the straight-line
 * code of static initializers (enum constants built with constructors and builder chains).
 *
 * Used only by scripts/build-knowledge.ts (an operator tool; nothing here runs in the agent).
 * The lint forbids spawning processes, so `javap` is not an option.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Jar (zip) reading
// ---------------------------------------------------------------------------

export interface Jar {
  readonly path: string;
  names(): string[];
  read(name: string): Buffer | null;
}

export function openJar(path: string): Jar {
  const buf = readFileSync(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${path}: not a zip file (no end of central directory)`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, { method: number; size: number; local: number }>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path}: bad central directory`);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    path,
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (e === undefined) return null;
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const raw = buf.subarray(start, start + e.size);
      if (e.method === 0) return Buffer.from(raw);
      if (e.method === 8) return inflateRawSync(raw);
      throw new Error(`${path}: ${name} uses unsupported compression ${e.method}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Class files
// ---------------------------------------------------------------------------

type Constant =
  | { tag: 'utf8'; value: string }
  | { tag: 'int'; value: number }
  | { tag: 'float'; value: number }
  | { tag: 'long'; value: bigint }
  | { tag: 'double'; value: number }
  | { tag: 'class'; name: number }
  | { tag: 'string'; utf8: number }
  | { tag: 'ref'; kind: 'field' | 'method' | 'imethod'; cls: number; nat: number }
  | { tag: 'nat'; name: number; desc: number }
  | { tag: 'indy'; nat: number }
  | { tag: 'other' };

export interface MethodInfo {
  name: string;
  desc: string;
  code: Buffer | null;
}

export interface ClassFile {
  name: string;
  methods: MethodInfo[];
  constant(index: number): Constant | undefined;
  utf8(index: number): string;
  className(index: number): string;
  ref(index: number): { owner: string; name: string; desc: string };
  /** Every string constant (ldc "...") in the class. */
  strings(): string[];
}

/**
 * Java's "modified UTF-8" decoded as UTF-8: they differ only for NUL and characters outside
 * the Basic Multilingual Plane, which the names read here do not contain.
 */
function modifiedUtf8(bytes: Buffer): string {
  return bytes.toString('utf8');
}

export function parseClass(buf: Buffer): ClassFile {
  if (buf.readUInt32BE(0) !== 0xcafebabe) throw new Error('not a class file');
  let p = 8;
  const u1 = (): number => buf.readUInt8(p++);
  const u2 = (): number => {
    const v = buf.readUInt16BE(p);
    p += 2;
    return v;
  };
  const u4 = (): number => {
    const v = buf.readUInt32BE(p);
    p += 4;
    return v;
  };
  const cpCount = u2();
  const pool: Array<Constant | undefined> = [undefined];
  for (let i = 1; i < cpCount; i++) {
    const tag = u1();
    switch (tag) {
      case 1: {
        const len = u2();
        pool[i] = { tag: 'utf8', value: modifiedUtf8(buf.subarray(p, p + len)) };
        p += len;
        break;
      }
      case 3:
        pool[i] = { tag: 'int', value: buf.readInt32BE(p) };
        p += 4;
        break;
      case 4:
        pool[i] = { tag: 'float', value: buf.readFloatBE(p) };
        p += 4;
        break;
      case 5:
        pool[i] = { tag: 'long', value: buf.readBigInt64BE(p) };
        p += 8;
        pool[++i] = undefined;
        break;
      case 6:
        pool[i] = { tag: 'double', value: buf.readDoubleBE(p) };
        p += 8;
        pool[++i] = undefined;
        break;
      case 7:
        pool[i] = { tag: 'class', name: u2() };
        break;
      case 8:
        pool[i] = { tag: 'string', utf8: u2() };
        break;
      case 9:
      case 10:
      case 11:
        pool[i] = {
          tag: 'ref',
          kind: tag === 9 ? 'field' : tag === 10 ? 'method' : 'imethod',
          cls: u2(),
          nat: u2(),
        };
        break;
      case 12:
        pool[i] = { tag: 'nat', name: u2(), desc: u2() };
        break;
      case 15:
        p += 3;
        pool[i] = { tag: 'other' };
        break;
      case 16:
      case 19:
      case 20:
        p += 2;
        pool[i] = { tag: 'other' };
        break;
      case 17:
      case 18:
        p += 2;
        pool[i] = { tag: 'indy', nat: u2() };
        break;
      default:
        throw new Error(`unknown constant pool tag ${tag} at entry ${i}`);
    }
  }
  const utf8 = (index: number): string => {
    const c = pool[index];
    if (c?.tag !== 'utf8') throw new Error(`constant ${index} is not UTF-8`);
    return c.value;
  };
  const className = (index: number): string => {
    const c = pool[index];
    if (c?.tag !== 'class') throw new Error(`constant ${index} is not a class`);
    return utf8(c.name);
  };
  // (Never write `p += u2()`: the read moves p, and the old p would be used.)
  p += 2; // access flags
  const thisClass = className(u2());
  p += 2; // super class
  const interfaces = u2();
  p += 2 * interfaces;
  const skipAttributes = (): void => {
    const n = u2();
    for (let i = 0; i < n; i++) {
      p += 2;
      const len = u4();
      p += len;
    }
  };
  const fields = u2();
  for (let i = 0; i < fields; i++) {
    p += 6;
    skipAttributes();
  }
  const methods: MethodInfo[] = [];
  const methodCount = u2();
  for (let i = 0; i < methodCount; i++) {
    p += 2;
    const name = utf8(u2());
    const desc = utf8(u2());
    let code: Buffer | null = null;
    const attrs = u2();
    for (let a = 0; a < attrs; a++) {
      const attrName = utf8(u2());
      const len = u4();
      if (attrName === 'Code') {
        const codeLen = buf.readUInt32BE(p + 4);
        code = buf.subarray(p + 8, p + 8 + codeLen);
      }
      p += len;
    }
    methods.push({ name, desc, code });
  }
  return {
    name: thisClass,
    methods,
    constant: (index) => pool[index],
    utf8,
    className,
    ref(index) {
      const c = pool[index];
      if (c?.tag !== 'ref') throw new Error(`constant ${index} is not a member reference`);
      const nat = pool[c.nat];
      if (nat?.tag !== 'nat') throw new Error(`constant ${c.nat} is not a name-and-type`);
      return { owner: className(c.cls), name: utf8(nat.name), desc: utf8(nat.desc) };
    },
    strings: () => pool.flatMap((c) => (c?.tag === 'string' ? [utf8(c.utf8)] : [])),
  };
}

// ---------------------------------------------------------------------------
// Symbolic interpretation of straight-line code
// ---------------------------------------------------------------------------

/** A value on the symbolic operand stack. Objects are shared by reference (dup). */
export type Value =
  | { t: 'int'; v: number }
  | { t: 'float'; v: number }
  | { t: 'str'; v: string }
  | { t: 'null' }
  | { t: 'static'; owner: string; name: string }
  | { t: 'new'; cls: string; args: Value[] | null; fields?: Map<string, Value> }
  | { t: 'array'; items: Value[] }
  | { t: 'call'; owner: string; name: string; desc: string; recv: Value | null; args: Value[] }
  | { t: 'field'; recv: Value; owner: string; name: string }
  | { t: 'unknown' };

export interface Call {
  owner: string;
  name: string;
  desc: string;
  recv: Value | null;
  args: Value[];
}

export interface Trace {
  /** Every putstatic, in order. */
  puts: Array<{ owner: string; name: string; value: Value }>;
  /** Every invocation, in order (constructors included, with name "<init>"). */
  calls: Call[];
}

/** Parameter count of a method descriptor (each parameter is one symbolic value). */
export function paramCount(desc: string): number {
  let n = 0;
  let i = desc.indexOf('(') + 1;
  while (desc[i] !== ')') {
    while (desc[i] === '[') i++;
    if (desc[i] === 'L') i = desc.indexOf(';', i);
    i++;
    n++;
  }
  return n;
}

const UNKNOWN: Value = { t: 'unknown' };

/**
 * Runs a method's code once, top to bottom, on symbolic values: constants, static fields,
 * new objects, arrays, and invocations become values; branches are not taken (the data
 * tables this is used for are straight-line code). Unknown effects become 'unknown'.
 */
export function interpret(cls: ClassFile, method: string | MethodInfo): Trace {
  const m = typeof method === 'string' ? cls.methods.find((x) => x.name === method) : method;
  const name = typeof method === 'string' ? method : method.name;
  if (m?.code == null) throw new Error(`${cls.name}.${name}: no code`);
  const code = m.code;
  const stack: Value[] = [];
  const locals = new Map<number, Value>();
  const trace: Trace = { puts: [], calls: [] };
  const pop = (): Value => stack.pop() ?? UNKNOWN;
  const popN = (n: number): Value[] => {
    const out: Value[] = [];
    for (let i = 0; i < n; i++) out.unshift(pop());
    return out;
  };
  const ldc = (index: number): Value => {
    const c = cls.constant(index);
    if (c === undefined) return UNKNOWN;
    switch (c.tag) {
      case 'int':
        return { t: 'int', v: c.value };
      case 'float':
      case 'double':
        return { t: 'float', v: c.value };
      case 'long':
        return { t: 'int', v: Number(c.value) };
      case 'string':
        return { t: 'str', v: cls.utf8(c.utf8) };
      case 'utf8':
      case 'class':
      case 'ref':
      case 'nat':
      case 'indy':
      case 'other':
        return UNKNOWN;
    }
  };
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc] ?? 0;
    const at = pc;
    const s1 = (): number => code.readInt8(at + 1);
    const u1 = (): number => code.readUInt8(at + 1);
    const s2 = (): number => code.readInt16BE(at + 1);
    const u2 = (): number => code.readUInt16BE(at + 1);
    let len = 1;
    if (op === 0x00) {
      // nop
    } else if (op === 0x01) stack.push({ t: 'null' });
    else if (op >= 0x02 && op <= 0x08) stack.push({ t: 'int', v: op - 0x03 });
    else if (op === 0x09 || op === 0x0a) stack.push({ t: 'int', v: op - 0x09 });
    else if (op >= 0x0b && op <= 0x0d) stack.push({ t: 'float', v: op - 0x0b });
    else if (op === 0x0e || op === 0x0f) stack.push({ t: 'float', v: op - 0x0e });
    else if (op === 0x10) {
      stack.push({ t: 'int', v: s1() });
      len = 2;
    } else if (op === 0x11) {
      stack.push({ t: 'int', v: s2() });
      len = 3;
    } else if (op === 0x12) {
      stack.push(ldc(u1()));
      len = 2;
    } else if (op === 0x13 || op === 0x14) {
      stack.push(ldc(u2()));
      len = 3;
    } else if (op >= 0x15 && op <= 0x19) {
      stack.push(locals.get(u1()) ?? UNKNOWN);
      len = 2;
    } else if (op >= 0x1a && op <= 0x2d) {
      stack.push(locals.get((op - 0x1a) % 4) ?? UNKNOWN);
    } else if (op >= 0x2e && op <= 0x35) {
      popN(2);
      stack.push(UNKNOWN);
    } else if (op >= 0x36 && op <= 0x3a) {
      locals.set(u1(), pop());
      len = 2;
    } else if (op >= 0x3b && op <= 0x4e) {
      locals.set((op - 0x3b) % 4, pop());
    } else if (op >= 0x4f && op <= 0x56) {
      const [arr, index, value] = popN(3);
      if (arr?.t === 'array' && index?.t === 'int' && value !== undefined) {
        arr.items[index.v] = value;
      }
    } else if (op === 0x57) pop();
    else if (op === 0x58) popN(2);
    else if (op === 0x59) {
      const v = pop();
      stack.push(v, v);
    } else if (op === 0x5a) {
      const [a, b] = popN(2);
      stack.push(b ?? UNKNOWN, a ?? UNKNOWN, b ?? UNKNOWN);
    } else if (op === 0x5b) {
      const [a, b, c] = popN(3);
      stack.push(c ?? UNKNOWN, a ?? UNKNOWN, b ?? UNKNOWN, c ?? UNKNOWN);
    } else if (op === 0x5c) {
      const [a, b] = popN(2);
      stack.push(a ?? UNKNOWN, b ?? UNKNOWN, a ?? UNKNOWN, b ?? UNKNOWN);
    } else if (op === 0x5d || op === 0x5e) {
      // dup2_x1 / dup2_x2: rare in data tables; keep the stack depth plausible.
      const v = pop();
      stack.push(v, v);
    } else if (op === 0x5f) {
      const [a, b] = popN(2);
      stack.push(b ?? UNKNOWN, a ?? UNKNOWN);
    } else if (op >= 0x60 && op <= 0x73) {
      popN(2);
      stack.push(UNKNOWN);
    } else if (op >= 0x74 && op <= 0x77) {
      pop();
      stack.push(UNKNOWN);
    } else if (op >= 0x78 && op <= 0x83) {
      popN(2);
      stack.push(UNKNOWN);
    } else if (op === 0x84) len = 3;
    else if (op >= 0x85 && op <= 0x93) {
      const v = pop();
      stack.push(v.t === 'int' || v.t === 'float' ? v : UNKNOWN);
    } else if (op >= 0x94 && op <= 0x98) {
      popN(2);
      stack.push(UNKNOWN);
    } else if (op >= 0x99 && op <= 0x9e) {
      pop();
      len = 3;
    } else if (op >= 0x9f && op <= 0xa6) {
      popN(2);
      len = 3;
    } else if (op === 0xa7 || op === 0xa8) len = 3;
    else if (op === 0xa9) len = 2;
    else if (op === 0xaa || op === 0xab) {
      pop();
      let q = at + 1;
      while (q % 4 !== 0) q++;
      if (op === 0xaa) {
        const low = code.readInt32BE(q + 4);
        const high = code.readInt32BE(q + 8);
        len = q + 12 + 4 * (high - low + 1) - at;
      } else {
        const pairs = code.readInt32BE(q + 4);
        len = q + 8 + 8 * pairs - at;
      }
    } else if (op >= 0xac && op <= 0xb1) {
      // A return: straight-line code ends here, but keep going (lambdas follow returns
      // only in separate methods; anything after a return is a branch target).
      stack.length = 0;
    } else if (op === 0xb2) {
      const r = cls.ref(u2());
      stack.push({ t: 'static', owner: r.owner, name: r.name });
      len = 3;
    } else if (op === 0xb3) {
      const r = cls.ref(u2());
      trace.puts.push({ owner: r.owner, name: r.name, value: pop() });
      len = 3;
    } else if (op === 0xb4) {
      const r = cls.ref(u2());
      stack.push({ t: 'field', recv: pop(), owner: r.owner, name: r.name });
      len = 3;
    } else if (op === 0xb5) {
      popN(2);
      len = 3;
    } else if (op >= 0xb6 && op <= 0xb9) {
      const r = cls.ref(u2());
      const args = popN(paramCount(r.desc));
      const recv = op === 0xb8 ? null : pop();
      trace.calls.push({ owner: r.owner, name: r.name, desc: r.desc, recv, args });
      if (r.name === '<init>' && recv?.t === 'new') recv.args = args;
      else if (!r.desc.endsWith(')V')) {
        stack.push({ t: 'call', owner: r.owner, name: r.name, desc: r.desc, recv, args });
      }
      len = op === 0xb9 ? 5 : 3;
    } else if (op === 0xba) {
      // invokedynamic (a lambda or string concatenation): consumes its arguments.
      const c = cls.constant(u2());
      const nat = c?.tag === 'indy' ? cls.constant(c.nat) : undefined;
      const desc = nat?.tag === 'nat' ? cls.utf8(nat.desc) : '()V';
      popN(paramCount(desc));
      if (!desc.endsWith(')V')) stack.push(UNKNOWN);
      len = 5;
    } else if (op === 0xbb) {
      stack.push({ t: 'new', cls: cls.className(u2()), args: null });
      len = 3;
    } else if (op === 0xbc) {
      pop();
      stack.push({ t: 'array', items: [] });
      len = 2;
    } else if (op === 0xbd) {
      pop();
      stack.push({ t: 'array', items: [] });
      len = 3;
    } else if (op === 0xbe) {
      pop();
      stack.push(UNKNOWN);
    } else if (op === 0xbf) pop();
    else if (op === 0xc0) len = 3;
    else if (op === 0xc1) {
      pop();
      stack.push(UNKNOWN);
      len = 3;
    } else if (op === 0xc2 || op === 0xc3) pop();
    else if (op === 0xc4) {
      // wide: iinc takes 5 operand bytes, the loads and stores 3.
      const inner = code[at + 1];
      if (inner === 0x84) len = 6;
      else {
        if (inner !== undefined && inner >= 0x15 && inner <= 0x19) stack.push(UNKNOWN);
        else pop();
        len = 4;
      }
    } else if (op === 0xc5) {
      popN(code.readUInt8(at + 3));
      stack.push({ t: 'array', items: [] });
      len = 4;
    } else if (op === 0xc6 || op === 0xc7) {
      pop();
      len = 3;
    } else if (op === 0xc8 || op === 0xc9) len = 5;
    else throw new Error(`${cls.name}.${m.name}: unsupported opcode 0x${op.toString(16)} at ${at}`);
    pc = at + len;
  }
  return trace;
}

/** The int constants a method pushes (iconst, bipush, sipush), walking whole instructions. */
export function intConstants(code: Buffer): number[] {
  const out: number[] = [];
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc] ?? 0;
    let len = 1;
    if (op >= 0x02 && op <= 0x08) out.push(op - 0x03);
    else if (op === 0x10) {
      out.push(code.readInt8(pc + 1));
      len = 2;
    } else if (op === 0x11) {
      out.push(code.readInt16BE(pc + 1));
      len = 3;
    } else if (op === 0x12 || (op >= 0x15 && op <= 0x19) || (op >= 0x36 && op <= 0x3a)) len = 2;
    else if (op === 0xa9 || op === 0xbc) len = 2;
    else if (op === 0x13 || op === 0x14 || op === 0x84 || (op >= 0x99 && op <= 0xa8)) len = 3;
    else if ((op >= 0xb2 && op <= 0xb8) || op === 0xbb || op === 0xbd || op === 0xc0) len = 3;
    else if (op === 0xc1 || op === 0xc6 || op === 0xc7) len = 3;
    else if (op === 0xb9 || op === 0xba || op === 0xc8 || op === 0xc9) len = 5;
    else if (op === 0xc5) len = 4;
    else if (op === 0xc4) len = code[pc + 1] === 0x84 ? 6 : 4;
    else if (op === 0xaa || op === 0xab) {
      let q = pc + 1;
      while (q % 4 !== 0) q++;
      len =
        op === 0xaa
          ? q + 12 + 4 * (code.readInt32BE(q + 8) - code.readInt32BE(q + 4) + 1) - pc
          : q + 8 + 8 * code.readInt32BE(q + 4) - pc;
    }
    pc += len;
  }
  return out;
}

/** Every method of a class with code, interpreted one by one (lambdas are methods too). */
export function interpretAll(cls: ClassFile): Trace {
  const all: Trace = { puts: [], calls: [] };
  for (const m of cls.methods) {
    if (m.code === null) continue;
    const t = interpret(cls, m);
    all.puts.push(...t.puts);
    all.calls.push(...t.calls);
  }
  return all;
}

/** Follows a builder chain down to the object it started from. */
export function chainRoot(v: Value): Value {
  let cur = v;
  while (cur.t === 'call' && cur.recv !== null) cur = cur.recv;
  return cur;
}

/** The calls of a builder chain, first call first (the root is excluded). */
export function chainCalls(v: Value): Array<{ name: string; args: Value[] }> {
  const out: Array<{ name: string; args: Value[] }> = [];
  let cur = v;
  while (cur.t === 'call' && cur.recv !== null) {
    out.unshift({ name: cur.name, args: cur.args });
    cur = cur.recv;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Concrete execution (loops over data arrays)
// ---------------------------------------------------------------------------

export interface ExecOptions {
  /** Loads a class by internal name (for static helpers), or null. */
  load: (name: string) => ClassFile | null;
  /** Static helper methods it may run itself when their arguments are known (owner, name). */
  pure?: (owner: string, name: string) => boolean;
  /** Instruction budget for the whole run (loops end when it runs out). */
  budget?: { left: number };
  depth?: number;
}

const intOf = (v: Value | undefined): number | null => (v?.t === 'int' ? v.v : null);

/** int (and, treated alike, long) arithmetic and bit operations; null when undefined. */
function intBinary(op: number, a: number, b: number): number | null {
  const norm = op <= 0x73 ? op - ((op - 0x60) % 4) : op - ((op - 0x78) % 2);
  switch (norm) {
    case 0x60:
      return (a + b) | 0;
    case 0x64:
      return (a - b) | 0;
    case 0x68:
      return Math.imul(a, b);
    case 0x6c:
      return b === 0 ? null : (a / b) | 0;
    case 0x70:
      return b === 0 ? null : a % b;
    case 0x78:
      return a << b;
    case 0x7a:
      return a >> b;
    case 0x7c:
      return a >>> b;
    case 0x7e:
      return a & b;
    case 0x80:
      return a | b;
    case 0x82:
      return a ^ b;
    default:
      return null;
  }
}

const INT_TESTS: ReadonlyArray<(a: number, b: number) => boolean> = [
  (a, b) => a === b,
  (a, b) => a !== b,
  (a, b) => a < b,
  (a, b) => a >= b,
  (a, b) => a > b,
  (a, b) => a <= b,
];

/**
 * Runs one method with concrete control flow: integer arithmetic, comparisons and branches
 * are evaluated when their values are known (an unknown condition falls through), arrays and
 * the fields of objects it creates hold values, and the static helpers `pure` names run
 * recursively. Every other call is recorded, as `interpret` does. Used for the vanilla recipe
 * classes, which build their recipes in loops over arrays their constructors set up.
 */
export function execute(
  cls: ClassFile,
  method: MethodInfo,
  self: Value | null,
  args: Value[],
  opts: ExecOptions,
  trace: Trace = { puts: [], calls: [] },
): { trace: Trace; returned: Value | null } {
  const code = method.code;
  if (code === null) return { trace, returned: null };
  const budget = opts.budget ?? { left: 2_000_000 };
  const depth = opts.depth ?? 0;
  const stack: Value[] = [];
  const locals = new Map<number, Value>();
  let slot = 0;
  if (self !== null) locals.set(slot++, self);
  for (const a of args) locals.set(slot++, a);
  const pop = (): Value => stack.pop() ?? UNKNOWN;
  const popN = (n: number): Value[] => {
    const out: Value[] = [];
    for (let i = 0; i < n; i++) out.unshift(pop());
    return out;
  };
  const ldc = (index: number): Value => {
    const c = cls.constant(index);
    if (c?.tag === 'int') return { t: 'int', v: c.value };
    if (c?.tag === 'float' || c?.tag === 'double') return { t: 'float', v: c.value };
    if (c?.tag === 'long') return { t: 'int', v: Number(c.value) };
    if (c?.tag === 'string') return { t: 'str', v: cls.utf8(c.utf8) };
    return UNKNOWN;
  };
  /** Reference equality where it can be told (the same object, the same static field). */
  const same = (a: Value, b: Value): boolean | null => {
    if (a === b) return true;
    if (a.t === 'null' || b.t === 'null') return a.t === b.t;
    if (a.t === 'static' && b.t === 'static') return a.owner === b.owner && a.name === b.name;
    return null;
  };
  /** How often each branch with an unknown condition was reached (loops over unknowns). */
  const unknownVisits = new Map<number, number>();
  let pc = 0;
  while (pc < code.length) {
    if (--budget.left <= 0) break;
    const op = code[pc] ?? 0;
    const at = pc;
    const s1 = (): number => code.readInt8(at + 1);
    const u1 = (): number => code.readUInt8(at + 1);
    const s2 = (): number => code.readInt16BE(at + 1);
    const u2 = (): number => code.readUInt16BE(at + 1);
    let next = at + 1;
    const branch = (taken: boolean | null): void => {
      // An unknown condition falls through the first time and branches after that, so a
      // loop over an unknown count runs its body once, whichever way it was compiled.
      let go = taken;
      if (go === null) {
        const seen = unknownVisits.get(at) ?? 0;
        unknownVisits.set(at, seen + 1);
        go = seen > 0;
      }
      next = go ? at + s2() : at + 3;
    };
    if (op === 0x00) {
      // nop
    } else if (op === 0x01) stack.push({ t: 'null' });
    else if (op >= 0x02 && op <= 0x08) stack.push({ t: 'int', v: op - 0x03 });
    else if (op === 0x09 || op === 0x0a) stack.push({ t: 'int', v: op - 0x09 });
    else if (op >= 0x0b && op <= 0x0d) stack.push({ t: 'float', v: op - 0x0b });
    else if (op === 0x0e || op === 0x0f) stack.push({ t: 'float', v: op - 0x0e });
    else if (op === 0x10) {
      stack.push({ t: 'int', v: s1() });
      next = at + 2;
    } else if (op === 0x11) {
      stack.push({ t: 'int', v: s2() });
      next = at + 3;
    } else if (op === 0x12) {
      stack.push(ldc(u1()));
      next = at + 2;
    } else if (op === 0x13 || op === 0x14) {
      stack.push(ldc(u2()));
      next = at + 3;
    } else if (op >= 0x15 && op <= 0x19) {
      stack.push(locals.get(u1()) ?? UNKNOWN);
      next = at + 2;
    } else if (op >= 0x1a && op <= 0x2d) stack.push(locals.get((op - 0x1a) % 4) ?? UNKNOWN);
    else if (op >= 0x2e && op <= 0x35) {
      const [arr, index] = popN(2);
      const i = intOf(index);
      stack.push(arr?.t === 'array' && i !== null ? (arr.items[i] ?? UNKNOWN) : UNKNOWN);
    } else if (op >= 0x36 && op <= 0x3a) {
      locals.set(u1(), pop());
      next = at + 2;
    } else if (op >= 0x3b && op <= 0x4e) locals.set((op - 0x3b) % 4, pop());
    else if (op >= 0x4f && op <= 0x56) {
      const [arr, index, value] = popN(3);
      const i = intOf(index);
      if (arr?.t === 'array' && i !== null && value !== undefined) arr.items[i] = value;
    } else if (op === 0x57) pop();
    else if (op === 0x58) popN(2);
    else if (op === 0x59) {
      const v = pop();
      stack.push(v, v);
    } else if (op === 0x5a) {
      const [a, b] = popN(2);
      stack.push(b ?? UNKNOWN, a ?? UNKNOWN, b ?? UNKNOWN);
    } else if (op === 0x5b) {
      const [a, b, c] = popN(3);
      stack.push(c ?? UNKNOWN, a ?? UNKNOWN, b ?? UNKNOWN, c ?? UNKNOWN);
    } else if (op === 0x5c) {
      const [a, b] = popN(2);
      stack.push(a ?? UNKNOWN, b ?? UNKNOWN, a ?? UNKNOWN, b ?? UNKNOWN);
    } else if (op === 0x5f) {
      const [a, b] = popN(2);
      stack.push(b ?? UNKNOWN, a ?? UNKNOWN);
    } else if ((op >= 0x60 && op <= 0x73) || (op >= 0x78 && op <= 0x83)) {
      const [a, b] = popN(2);
      const x = intOf(a);
      const y = intOf(b);
      const r = x === null || y === null ? null : intBinary(op, x, y);
      stack.push(r === null ? UNKNOWN : { t: 'int', v: r });
    } else if (op >= 0x74 && op <= 0x77) {
      const x = intOf(pop());
      stack.push(x === null ? UNKNOWN : { t: 'int', v: -x | 0 });
    } else if (op === 0x84) {
      const idx = u1();
      const cur = intOf(locals.get(idx));
      locals.set(idx, cur === null ? UNKNOWN : { t: 'int', v: (cur + code.readInt8(at + 2)) | 0 });
      next = at + 3;
    } else if (op >= 0x85 && op <= 0x93) {
      const v = pop();
      if (op === 0x91 && v.t === 'int') stack.push({ t: 'int', v: (v.v << 24) >> 24 });
      else if (op === 0x92 && v.t === 'int') stack.push({ t: 'int', v: v.v & 0xffff });
      else if (op === 0x93 && v.t === 'int') stack.push({ t: 'int', v: (v.v << 16) >> 16 });
      else stack.push(v.t === 'int' || v.t === 'float' ? v : UNKNOWN);
    } else if (op >= 0x94 && op <= 0x98) {
      popN(2);
      stack.push(UNKNOWN);
    } else if (op >= 0x99 && op <= 0x9e) {
      const x = intOf(pop());
      const test = INT_TESTS[op - 0x99];
      branch(x === null || test === undefined ? null : test(x, 0));
    } else if (op >= 0x9f && op <= 0xa4) {
      const [a, b] = popN(2);
      const x = intOf(a);
      const y = intOf(b);
      const test = INT_TESTS[op - 0x9f];
      branch(x === null || y === null || test === undefined ? null : test(x, y));
    } else if (op === 0xa5 || op === 0xa6) {
      const [a, b] = popN(2);
      const eq = a === undefined || b === undefined ? null : same(a, b);
      branch(eq === null ? null : op === 0xa5 ? eq : !eq);
    } else if (op === 0xa7) branch(true);
    else if (op === 0xaa || op === 0xab) {
      const key = intOf(pop());
      let q = at + 1;
      while (q % 4 !== 0) q++;
      next = at + code.readInt32BE(q);
      if (op === 0xaa) {
        const low = code.readInt32BE(q + 4);
        const high = code.readInt32BE(q + 8);
        if (key !== null && key >= low && key <= high) {
          next = at + code.readInt32BE(q + 12 + 4 * (key - low));
        }
      } else {
        const pairs = code.readInt32BE(q + 4);
        for (let k = 0; k < pairs; k++) {
          if (key !== null && code.readInt32BE(q + 8 + 8 * k) === key) {
            next = at + code.readInt32BE(q + 12 + 8 * k);
          }
        }
      }
    } else if (op >= 0xac && op <= 0xb0) return { trace, returned: pop() };
    else if (op === 0xb1) return { trace, returned: null };
    else if (op === 0xb2) {
      const r = cls.ref(u2());
      stack.push({ t: 'static', owner: r.owner, name: r.name });
      next = at + 3;
    } else if (op === 0xb3) {
      const r = cls.ref(u2());
      trace.puts.push({ owner: r.owner, name: r.name, value: pop() });
      next = at + 3;
    } else if (op === 0xb4) {
      const r = cls.ref(u2());
      const recv = pop();
      const own = recv.t === 'new' ? recv.fields?.get(r.name) : undefined;
      stack.push(own ?? { t: 'field', recv, owner: r.owner, name: r.name });
      next = at + 3;
    } else if (op === 0xb5) {
      const r = cls.ref(u2());
      const [recv, value] = popN(2);
      if (recv?.t === 'new' && value !== undefined) {
        recv.fields ??= new Map();
        recv.fields.set(r.name, value);
      }
      next = at + 3;
    } else if (op >= 0xb6 && op <= 0xb9) {
      const r = cls.ref(u2());
      const callArgs = popN(paramCount(r.desc));
      const recv = op === 0xb8 ? null : pop();
      next = at + (op === 0xb9 ? 5 : 3);
      const returns = !r.desc.endsWith(')V');
      // A known static helper with known arguments: run it.
      if (
        op === 0xb8 &&
        depth < 4 &&
        opts.pure?.(r.owner, r.name) === true &&
        callArgs.every((a) => a.t === 'int' || a.t === 'str')
      ) {
        const target = opts.load(r.owner);
        const m = target?.methods.find((x) => x.name === r.name && x.desc === r.desc);
        if (target != null && m !== undefined) {
          const sub = execute(target, m, null, callArgs, { ...opts, budget, depth: depth + 1 });
          if (returns) stack.push(sub.returned ?? UNKNOWN);
          pc = next;
          continue;
        }
      }
      trace.calls.push({ owner: r.owner, name: r.name, desc: r.desc, recv, args: callArgs });
      if (r.name === '<init>' && recv?.t === 'new') recv.args = callArgs;
      else if (returns) {
        stack.push({ t: 'call', owner: r.owner, name: r.name, desc: r.desc, recv, args: callArgs });
      }
    } else if (op === 0xba) {
      const c = cls.constant(u2());
      const nat = c?.tag === 'indy' ? cls.constant(c.nat) : undefined;
      const desc = nat?.tag === 'nat' ? cls.utf8(nat.desc) : '()V';
      popN(paramCount(desc));
      if (!desc.endsWith(')V')) stack.push(UNKNOWN);
      next = at + 5;
    } else if (op === 0xbb) {
      stack.push({ t: 'new', cls: cls.className(u2()), args: null, fields: new Map() });
      next = at + 3;
    } else if (op === 0xbc || op === 0xbd) {
      const n = intOf(pop());
      const fill: Value = op === 0xbc ? { t: 'int', v: 0 } : { t: 'null' };
      const items = n === null || n < 0 || n > 4096 ? [] : new Array<Value>(n).fill(fill);
      stack.push({ t: 'array', items });
      next = at + (op === 0xbc ? 2 : 3);
    } else if (op === 0xbe) {
      const arr = pop();
      stack.push(arr.t === 'array' ? { t: 'int', v: arr.items.length } : UNKNOWN);
    } else if (op === 0xbf) return { trace, returned: null };
    else if (op === 0xc0) next = at + 3;
    else if (op === 0xc1) {
      pop();
      stack.push(UNKNOWN);
      next = at + 3;
    } else if (op === 0xc2 || op === 0xc3) pop();
    else if (op === 0xc5) {
      popN(code.readUInt8(at + 3));
      stack.push({ t: 'array', items: [] });
      next = at + 4;
    } else if (op === 0xc6 || op === 0xc7) {
      const v = pop();
      const isNull = v.t === 'null' ? true : v.t === 'unknown' ? null : false;
      branch(isNull === null ? null : op === 0xc6 ? isNull : !isNull);
    } else if (op === 0xc8) next = at + code.readInt32BE(at + 1);
    else break; // jsr, ret and wide do not occur in the data tables read here
    pc = next;
  }
  return { trace, returned: null };
}
