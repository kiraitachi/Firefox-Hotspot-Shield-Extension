// Minimal protobuf wire-format codec: just the pieces the Hotspot Shield API uses
// (varint scalars, strings, nested messages). Unknown fields are skipped on decode.
// Verified byte-for-byte against the protobufjs code generated in the official
// extension (see tests/codec.test.js and tools/gen-golden.cjs).

const utf8 = new TextEncoder();
const utf8d = new TextDecoder('utf-8');

export class Writer {
  #chunks = [];
  #length = 0;

  #push(bytes) {
    this.#chunks.push(bytes);
    this.#length += bytes.length;
  }

  varint(value) {
    let v = BigInt(value);
    if (v < 0n) v += 1n << 64n; // protobuf encodes negatives as 64-bit two's complement
    const out = [];
    while (v >= 0x80n) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v));
    this.#push(Uint8Array.from(out));
    return this;
  }

  tag(field, wireType) {
    return this.varint((field << 3) | wireType);
  }

  bytes(u8) {
    this.varint(u8.length);
    this.#push(u8);
    return this;
  }

  string(s) {
    return this.bytes(utf8.encode(s));
  }

  finish() {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export class Reader {
  pos = 0;

  constructor(buf) {
    this.buf = buf;
  }

  get done() {
    return this.pos >= this.buf.length;
  }

  varint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('protobuf: truncated varint');
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
      if (shift > 63n) throw new Error('protobuf: varint too long');
    }
  }

  bytes() {
    const length = Number(this.varint());
    if (this.pos + length > this.buf.length) throw new Error('protobuf: truncated field');
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  skip(wireType) {
    switch (wireType) {
      case 0: this.varint(); break;
      case 1: this.pos += 8; break;
      case 2: this.bytes(); break;
      case 5: this.pos += 4; break;
      default: throw new Error(`protobuf: unsupported wire type ${wireType}`);
    }
  }
}

const SCALARS = {
  int32: {
    wire: 0,
    write: (w, v) => w.varint(BigInt.asIntN(32, BigInt(v))),
    read: (r) => Number(BigInt.asIntN(32, r.varint())),
  },
  uint32: {
    wire: 0,
    write: (w, v) => w.varint(BigInt.asUintN(32, BigInt(v))),
    read: (r) => Number(BigInt.asUintN(32, r.varint())),
  },
  uint64: {
    wire: 0,
    write: (w, v) => w.varint(BigInt.asUintN(64, BigInt(v))),
    read: (r) => {
      const v = r.varint();
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    },
  },
  bool: { wire: 0, write: (w, v) => w.varint(v ? 1 : 0), read: (r) => r.varint() !== 0n },
  string: { wire: 2, write: (w, v) => w.string(String(v)), read: (r) => utf8d.decode(r.bytes()) },
};

// A schema is { fields: [[fieldNumber, name, type, flag?], ...] } with fields in ascending
// order, where `type` is a scalar name above or another schema (nested message) and
// `flag` is 'required' (always written; we throw if absent, the official encoder crashes)
// or 'repeated' (array; written unpacked like the official encoder, read packed or not).
function writeValue(w, num, type, value) {
  if (typeof type === 'object') {
    w.tag(num, 2).bytes(encodeMessage(type, value));
  } else {
    const scalar = SCALARS[type];
    w.tag(num, scalar.wire);
    scalar.write(w, value);
  }
}

export function encodeMessage(schema, obj) {
  const w = new Writer();
  for (const [num, name, type, flag] of schema.fields) {
    const value = obj?.[name];
    if (flag === 'repeated') {
      for (const item of value ?? []) writeValue(w, num, type, item);
      continue;
    }
    if (value === undefined || value === null) {
      if (flag === 'required') throw new Error(`protobuf: required field "${name}" is missing`);
      continue;
    }
    writeValue(w, num, type, value);
  }
  return w.finish();
}

const indexCache = new WeakMap();
function fieldIndex(schema) {
  let index = indexCache.get(schema);
  if (!index) {
    index = new Map(schema.fields.map((f) => [f[0], f]));
    indexCache.set(schema, index);
  }
  return index;
}

export function decodeMessage(schema, buf) {
  const r = new Reader(buf);
  const index = fieldIndex(schema);
  const out = {};
  while (!r.done) {
    const key = Number(r.varint());
    const num = key >>> 3;
    const wire = key & 7;
    const field = index.get(num);
    if (!field) {
      r.skip(wire);
      continue;
    }
    const [, name, type, flag] = field;
    const repeated = flag === 'repeated';
    const put = (value) => {
      if (repeated) (out[name] ??= []).push(value);
      else out[name] = value;
    };
    if (typeof type === 'object') {
      if (wire !== 2) {
        r.skip(wire);
        continue;
      }
      put(decodeMessage(type, r.bytes()));
      continue;
    }
    const scalar = SCALARS[type];
    if (repeated && scalar.wire === 0 && wire === 2) {
      // packed repeated scalar: one length-delimited blob of varints
      const packed = new Reader(r.bytes());
      while (!packed.done) put(scalar.read(packed));
      continue;
    }
    if (scalar.wire !== wire) {
      r.skip(wire);
      continue;
    }
    put(scalar.read(r));
  }
  return out;
}
