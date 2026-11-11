type Value = bigint | Buffer;
type Field = readonly [number, Value];

export function encodeTiebaFields(fields: Field[]): Buffer {
  const varint = (n: bigint) => {
    const bytes: number[] = [];
    while (n > 127n) {
      bytes.push(Number(n & 127n) | 128);
      n >>= 7n;
    }
    bytes.push(Number(n));
    return Buffer.from(bytes);
  };
  return Buffer.concat(
    fields.flatMap(([number, value]) =>
      typeof value === "bigint"
        ? [varint(BigInt(number * 8)), varint(value)]
        : [varint(BigInt(number * 8 + 2)), varint(BigInt(value.length)), value],
    ),
  );
}

export function tiebaFields(bytes: Buffer) {
  const fields: Field[] = [];
  let offset = 0;
  const varint = () => {
    let n = 0n;
    for (let shift = 0n; shift <= 63n && offset < bytes.length; shift += 7n) {
      const byte = bytes[offset++];
      if (shift === 63n && byte > 1) break;
      n |= BigInt(byte & 127) << shift;
      if (byte < 128) return n;
    }
    throw new Error("Invalid protobuf varint");
  };
  const take = (length: number) => {
    const end = offset + length;
    if (end > bytes.length) throw new Error("Truncated protobuf field");
    const value = bytes.subarray(offset, end);
    offset = end;
    return value;
  };
  while (offset < bytes.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    if (number < 1 || number > 0x1fffffff)
      throw new Error("Invalid protobuf field");
    switch (Number(tag & 7n)) {
      case 0:
        fields.push([number, varint()]);
        break;
      case 2:
        fields.push([number, take(Number(varint()))]);
        break;
      case 1:
        take(8);
        break;
      case 5:
        take(4);
        break;
      default:
        throw new Error("Unsupported protobuf field");
    }
  }
  return {
    integer: (field: number) => {
      const value = fields.findLast(([id]) => id === field)?.[1];
      return typeof value === "bigint" ? value : undefined;
    },
    bytes: (field: number) => {
      const value = fields.findLast(([id]) => id === field)?.[1];
      return Buffer.isBuffer(value) ? value : undefined;
    },
    messages: (field: number) =>
      fields.flatMap(([id, value]) =>
        id === field && Buffer.isBuffer(value) ? [tiebaFields(value)] : [],
      ),
    string: (field: number) => {
      const value = fields.findLast(([id]) => id === field)?.[1];
      return Buffer.isBuffer(value) ? value.toString("utf8").trim() : "";
    },
  };
}
