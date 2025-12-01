import { CborMap } from "./map";
import type { Simple } from "./simple";
import { simpleCborData, isFloat as isSimpleFloat } from "./simple";
import { hasFractionalPart } from "./float";
import { encodeVarInt } from "./varint";
import { concatBytes } from "./stdlib";
import { bytesToHex } from "./dump";
import { hexToBytes } from "./dump";
import type { Tag } from "./tag";
import type { ByteString } from "./byte-string";
import type { CborDate } from "./date";
import { diagnosticOpt } from "./diag";
import { decodeCbor } from "./decode";
import type { TagsStore } from "./tags-store";
import { getGlobalTagsStore } from "./tags-store";
import type { Visitor } from "./walk";
import { CborError } from './error';

export type { Simple };

export enum MajorType {
  Unsigned = 0,
  Negative = 1,
  ByteString = 2,
  Text = 3,
  Array = 4,
  Map = 5,
  Tagged = 6,
  Simple = 7,
}

export type CborNumber = number | bigint;

/**
 * Type for values that can be converted to CBOR.
 * Matches Rust's From<T> trait implementations for CBOR.
 */
export type CborEncodable =
  | Cbor
  | CborNumber
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | ByteString
  | CborDate
  | CborMap
  | CborEncodable[]
  | Map<unknown, unknown>
  | Set<unknown>
  | Record<string, unknown>;

export function isCborNumber(value: unknown): value is CborNumber {
  return typeof value === 'number' || typeof value === 'bigint';
}

export function isCbor(value: unknown): value is Cbor {
  return value !== null && typeof value === 'object' && 'isCbor' in value && value.isCbor === true;
}

export interface CborUnsignedType { isCbor: true; type: MajorType.Unsigned; value: CborNumber }
export interface CborNegativeType { isCbor: true; type: MajorType.Negative; value: CborNumber }
export interface CborByteStringType { isCbor: true; type: MajorType.ByteString; value: Uint8Array }
export interface CborTextType { isCbor: true; type: MajorType.Text; value: string }
export interface CborArrayType { isCbor: true; type: MajorType.Array; value: Cbor[] }
export interface CborMapType { isCbor: true; type: MajorType.Map; value: CborMap }
export interface CborTaggedType { isCbor: true; type: MajorType.Tagged; tag: CborNumber; value: Cbor }
export interface CborSimpleType { isCbor: true; type: MajorType.Simple; value: Simple }

// Instance methods interface
export interface CborMethods {
  // Universal encoding/formatting
  toData(): Uint8Array;
  toHex(): string;
  toHexAnnotated(tagsStore?: TagsStore): string;
  toString(): string;
  toDebugString(): string;
  toDiagnostic(): string;
  toDiagnosticAnnotated(): string;

  // Type checking
  isByteString(): boolean;
  isText(): boolean;
  isArray(): boolean;
  isMap(): boolean;
  isTagged(): boolean;
  isSimple(): boolean;
  isBool(): boolean;
  isTrue(): boolean;
  isFalse(): boolean;
  isNull(): boolean;
  isNumber(): boolean;
  isInteger(): boolean;
  isUnsigned(): boolean;
  isNegative(): boolean;
  isNaN(): boolean;
  isFloat(): boolean;

  // Safe conversion (returns undefined on mismatch)
  asByteString(): Uint8Array | undefined;
  asText(): string | undefined;
  asArray(): Cbor[] | undefined;
  asMap(): CborMap | undefined;
  asTagged(): [Tag, Cbor] | undefined;
  asBool(): boolean | undefined;
  asInteger(): (number | bigint) | undefined;
  asNumber(): (number | bigint) | undefined;
  asSimpleValue(): Simple | undefined;

  // Throwing conversion (throws on mismatch)
  toByteString(): Uint8Array;
  toText(): string;
  toArray(): Cbor[];
  toMap(): CborMap;
  toTagged(): [Tag, Cbor];
  toBool(): boolean;
  toInteger(): number | bigint;
  toNumber(): number | bigint;
  toSimpleValue(): Simple;
  expectTag(tag: CborNumber | Tag): Cbor;

  // Advanced operations
  walk<State>(initialState: State, visitor: Visitor<State>): State;
  validateTag(expectedTags: Tag[]): Tag;
  untagged(): Cbor;
}

export type Cbor = (CborUnsignedType |
  CborNegativeType | CborByteStringType | CborTextType |
  CborArrayType | CborMapType | CborTaggedType |
  CborSimpleType) & CborMethods;

// ============================================================================
// Encoding Functions (matches Rust CBOR conversion logic)
// ============================================================================

export interface ToCbor {
  toCbor(): Cbor;
}

export interface TaggedCborEncodable {
  taggedCbor(): Cbor;
}

/**
 * Type guard to check if value has taggedCbor method.
 */
function hasTaggedCbor(value: unknown): value is TaggedCborEncodable {
  return typeof value === 'object' && value !== null && 'taggedCbor' in value && typeof (value as TaggedCborEncodable).taggedCbor === 'function';
}

/**
 * Type guard to check if value has toCbor method.
 */
function hasToCbor(value: unknown): value is ToCbor {
  return typeof value === 'object' && value !== null && 'toCbor' in value && typeof (value as ToCbor).toCbor === 'function';
}

/**
 * Convert any value to a CBOR representation.
 * Matches Rust's `From` trait implementations for CBOR.
 */
export function cbor(value: CborEncodable): Cbor {
  // If already CBOR and has methods, return as-is
  if (isCbor(value) && 'toData' in value) {
    return value;
  }

  // If CBOR but no methods, attach them
  if (isCbor(value)) {
    return attachMethods(value as Omit<Cbor, keyof CborMethods>) as Cbor;
  }

  let result: Omit<Cbor, keyof CborMethods>;

  if (isCborNumber(value)) {
    if (typeof value === 'number' && Number.isNaN(value)) {
      result = { isCbor: true, type: MajorType.Simple, value: { type: 'Float', value: NaN } };
    } else if (typeof value === 'number' && hasFractionalPart(value)) {
      result = { isCbor: true, type: MajorType.Simple, value: { type: 'Float', value: value } };
    } else if (value == Infinity) {
      result = { isCbor: true, type: MajorType.Simple, value: { type: 'Float', value: Infinity } };
    } else if (value == -Infinity) {
      result = { isCbor: true, type: MajorType.Simple, value: { type: 'Float', value: -Infinity } };
    } else if (value < 0) {
      // Store the magnitude to encode, matching Rust's representation
      // For a negative value n, CBOR encodes it as -1-n, so we store -n-1
      if (typeof value === 'bigint') {
        result = { isCbor: true, type: MajorType.Negative, value: -value - 1n };
      } else {
        result = { isCbor: true, type: MajorType.Negative, value: -value - 1 };
      }
    } else {
      result = { isCbor: true, type: MajorType.Unsigned, value: value };
    }
  } else if (typeof value === 'string') {
    // dCBOR requires all text strings to be in Unicode Normalization Form C (NFC)
    // This ensures deterministic encoding regardless of how the string was composed
    const normalized = value.normalize('NFC');
    result = { isCbor: true, type: MajorType.Text, value: normalized };
  } else if (value === null) {
    result = { isCbor: true, type: MajorType.Simple, value: { type: 'Null' } };
  } else if (value === true) {
    result = { isCbor: true, type: MajorType.Simple, value: { type: 'True' } };
  } else if (value === false) {
    result = { isCbor: true, type: MajorType.Simple, value: { type: 'False' } };
  } else if (Array.isArray(value)) {
    result = { isCbor: true, type: MajorType.Array, value: value.map(cbor) };
  } else if (value instanceof Uint8Array) {
    result = { isCbor: true, type: MajorType.ByteString, value: value };
  } else if (value instanceof CborMap) {
    result = { isCbor: true, type: MajorType.Map, value: value };
  } else if (value instanceof Map) {
    result = { isCbor: true, type: MajorType.Map, value: new CborMap(value) };
  } else if (value instanceof Set) {
    result = { isCbor: true, type: MajorType.Array, value: Array.from(value).map(v => cbor(v as CborEncodable)) };
  } else if (hasTaggedCbor(value)) {
    return value.taggedCbor();
  } else if (hasToCbor(value)) {
    return value.toCbor();
  } else if (typeof value === 'object' && value !== null && 'tag' in value && 'value' in value) {
    // Handle plain tagged value format: { tag: number, value: unknown }
    const keys = Object.keys(value);
    const objValue = value as { tag: unknown; value: unknown; [key: string]: unknown };
    if (keys.length === 2 && keys.includes('tag') && keys.includes('value')) {
      return taggedCbor(objValue.tag, objValue.value as CborEncodable);
    }
    // Not a tagged value, fall through to map handling
    const map = new CborMap();
    for (const [key, val] of Object.entries(value)) {
      map.set(cbor(key as CborEncodable), cbor(val as CborEncodable));
    }
    result = { isCbor: true, type: MajorType.Map, value: map };
  } else if (typeof value === 'object' && value !== null) {
    // Handle plain objects by converting to CborMap
    const map = new CborMap();
    for (const [key, val] of Object.entries(value)) {
      map.set(cbor(key as CborEncodable), cbor(val as CborEncodable));
    }
    result = { isCbor: true, type: MajorType.Map, value: map };
  } else {
    throw new Error("Not supported");
  }

  return attachMethods(result) as Cbor;
}

export function cborHex(value: CborEncodable): string {
  return bytesToHex(cborData(value));
}

/**
 * Encode a CBOR value to binary data.
 * Matches Rust's `CBOR::to_cbor_data()` method.
 */
export function cborData(value: CborEncodable): Uint8Array {
  const c = cbor(value);
  switch (c.type) {
    case MajorType.Unsigned: {
    return encodeVarInt(c.value, MajorType.Unsigned);
  }
    case MajorType.Negative: {
    // Value is already stored as the magnitude to encode (matching Rust)
    return encodeVarInt(c.value, MajorType.Negative);
  }
    case MajorType.ByteString: {
    if (c.value instanceof Uint8Array) {
      const lengthBytes = encodeVarInt(c.value.length, MajorType.ByteString);
      return new Uint8Array([...lengthBytes, ...c.value]);
  }
    break;
  }
    case MajorType.Text: {
    if (typeof c.value === 'string') {
      const utf8Bytes = new TextEncoder().encode(c.value);
      const lengthBytes = encodeVarInt(utf8Bytes.length, MajorType.Text);
      return new Uint8Array([...lengthBytes, ...utf8Bytes]);
  }
    break;
  }
    case MajorType.Tagged: {
    if (typeof c.tag === 'bigint' || typeof c.tag === 'number') {
      const tagBytes = encodeVarInt(c.tag, MajorType.Tagged);
      const valueBytes = cborData(c.value);
      return new Uint8Array([...tagBytes, ...valueBytes]);
  }
    break;
  }
    case MajorType.Simple: {
    // Use the simpleCborData function from simple.ts
    return simpleCborData(c.value);
  }
    case MajorType.Array: {
    const arrayBytes = c.value.map(cborData);
    const flatArrayBytes = concatBytes(arrayBytes);
    const lengthBytes = encodeVarInt(c.value.length, MajorType.Array);
    return new Uint8Array([...lengthBytes, ...flatArrayBytes]);
  }
    case MajorType.Map: {
    const entries = c.value.entries;
    const arrayBytes = entries.map(({key, value}) => concatBytes([cborData(key), cborData(value)]));
    const flatArrayBytes = concatBytes(arrayBytes);
    const lengthBytes = encodeVarInt(entries.length, MajorType.Map);
    return new Uint8Array([...lengthBytes, ...flatArrayBytes]);
  }
  }
  throw new Error("Invalid CBOR");
}

export function encodeCbor(value: CborEncodable): Uint8Array {
  return cborData(cbor(value));
}

export function taggedCbor(tag: unknown, value: CborEncodable): Cbor {
  // Validate and convert tag to CborNumber
  const tagNumber: CborNumber = typeof tag === 'number' || typeof tag === 'bigint' ? tag : Number(tag);
  return attachMethods({
    isCbor: true,
    type: MajorType.Tagged,
    tag: tagNumber,
    value: cbor(value),
  });
}

// ============================================================================
// Static Factory Functions
// (Keep only essential creation functions)
// ============================================================================

export function toByteString(data: Uint8Array): Cbor {
  return cbor(data);
}

export function toByteStringFromHex(hex: string): Cbor {
  return toByteString(hexToBytes(hex));
}

export function toTaggedValue(tag: CborNumber | Tag, item: CborEncodable): Cbor {
  const tagValue = typeof tag === 'object' && 'value' in tag ? tag.value : tag;
  return attachMethods({
    isCbor: true,
    type: MajorType.Tagged,
    tag: tagValue,
    value: cbor(item)
  });
}

export function cborFalse(): Cbor {
  return attachMethods({ isCbor: true, type: MajorType.Simple, value: { type: 'False' } });
}

export function cborTrue(): Cbor {
  return attachMethods({ isCbor: true, type: MajorType.Simple, value: { type: 'True' } });
}

export function cborNull(): Cbor {
  return attachMethods({ isCbor: true, type: MajorType.Simple, value: { type: 'Null' } });
}

export function cborNaN(): Cbor {
  return attachMethods({ isCbor: true, type: MajorType.Simple, value: { type: 'Float', value: NaN } });
}

// ============================================================================
// Method Attachment System
// ============================================================================

/**
 * Attaches instance methods to a CBOR value.
 * This enables method chaining like cbor.toHex() instead of Cbor.toHex(cbor).
 * @internal
 */
export function attachMethods<T extends Omit<Cbor, keyof CborMethods>>(obj: T): T & CborMethods {
  return Object.assign(obj, {
    // Universal encoding/formatting
    toData(this: Cbor): Uint8Array {
      return cborData(this);
    },
    toHex(this: Cbor): string {
      return bytesToHex(cborData(this));
    },
    toHexAnnotated(this: Cbor, tagsStore?: TagsStore): string {
      // Use lazy import to avoid circular dependency
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef, @typescript-eslint/no-unsafe-assignment
      const { hexOpt } = require('./dump');
      tagsStore = tagsStore ?? getGlobalTagsStore();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
      return hexOpt(this, { annotate: true, tagsStore });
    },
    toString(this: Cbor): string {
      return diagnosticOpt(this, { flat: true });
    },
    toDebugString(this: Cbor): string {
      return diagnosticOpt(this, { flat: false });
    },
    toDiagnostic(this: Cbor): string {
      return diagnosticOpt(this, { flat: false });
    },
    toDiagnosticAnnotated(this: Cbor): string {
      return diagnosticOpt(this, { annotate: true });
    },

    // Type checking
    isByteString(this: Cbor): boolean {
      return this.type === MajorType.ByteString;
    },
    isText(this: Cbor): boolean {
      return this.type === MajorType.Text;
    },
    isArray(this: Cbor): boolean {
      return this.type === MajorType.Array;
    },
    isMap(this: Cbor): boolean {
      return this.type === MajorType.Map;
    },
    isTagged(this: Cbor): boolean {
      return this.type === MajorType.Tagged;
    },
    isSimple(this: Cbor): boolean {
      return this.type === MajorType.Simple;
    },
    isBool(this: Cbor): boolean {
      return this.type === MajorType.Simple &&
             (this.value.type === 'True' || this.value.type === 'False');
    },
    isTrue(this: Cbor): boolean {
      return this.type === MajorType.Simple && this.value.type === 'True';
    },
    isFalse(this: Cbor): boolean {
      return this.type === MajorType.Simple && this.value.type === 'False';
    },
    isNull(this: Cbor): boolean {
      return this.type === MajorType.Simple && this.value.type === 'Null';
    },
    isNumber(this: Cbor): boolean {
      if (this.type === MajorType.Unsigned || this.type === MajorType.Negative) {
        return true;
      }
      if (this.type === MajorType.Simple) {
        return isSimpleFloat(this.value);
      }
      return false;
    },
    isInteger(this: Cbor): boolean {
      return this.type === MajorType.Unsigned || this.type === MajorType.Negative;
    },
    isUnsigned(this: Cbor): boolean {
      return this.type === MajorType.Unsigned;
    },
    isNegative(this: Cbor): boolean {
      return this.type === MajorType.Negative;
    },
    isNaN(this: Cbor): boolean {
      return this.type === MajorType.Simple &&
             this.value.type === 'Float' &&
             Number.isNaN(this.value.value);
    },
    isFloat(this: Cbor): boolean {
      return this.type === MajorType.Simple && isSimpleFloat(this.value);
    },

    // Safe conversion (returns undefined on mismatch)
    asByteString(this: Cbor): Uint8Array | undefined {
      return this.type === MajorType.ByteString ? this.value : undefined;
    },
    asText(this: Cbor): string | undefined {
      return this.type === MajorType.Text ? this.value : undefined;
    },
    asArray(this: Cbor): Cbor[] | undefined {
      return this.type === MajorType.Array ? this.value : undefined;
    },
    asMap(this: Cbor): CborMap | undefined {
      return this.type === MajorType.Map ? this.value : undefined;
    },
    asTagged(this: Cbor): [Tag, Cbor] | undefined {
      if (this.type !== MajorType.Tagged) {
        return undefined;
      }
      const tag: Tag = { value: this.tag, name: `tag-${this.tag}` };
      return [tag, this.value];
    },
    asBool(this: Cbor): boolean | undefined {
      if (this.type !== MajorType.Simple) return undefined;
      if (this.value.type === 'True') return true;
      if (this.value.type === 'False') return false;
      return undefined;
    },
    asInteger(this: Cbor): (number | bigint) | undefined {
      if (this.type === MajorType.Unsigned) {
        return this.value;
      } else if (this.type === MajorType.Negative) {
        if (typeof this.value === 'bigint') {
          return -this.value - 1n;
        } else {
          return -this.value - 1;
        }
      }
      return undefined;
    },
    asNumber(this: Cbor): (number | bigint) | undefined {
      if (this.type === MajorType.Unsigned) {
        return this.value;
      } else if (this.type === MajorType.Negative) {
        if (typeof this.value === 'bigint') {
          return -this.value - 1n;
        } else {
          return -this.value - 1;
        }
      } else if (this.type === MajorType.Simple && isSimpleFloat(this.value)) {
        return this.value.value;
      }
      return undefined;
    },
    asSimpleValue(this: Cbor): Simple | undefined {
      return this.type === MajorType.Simple ? this.value : undefined;
    },

    // Throwing conversion (throws on mismatch)
    toByteString(this: Cbor): Uint8Array {
      if (this.type !== MajorType.ByteString) {
        throw new TypeError(`Cannot convert CBOR to ByteString: expected ByteString type, got ${MajorType[this.type]}`);
      }
      return this.value;
    },
    toText(this: Cbor): string {
      if (this.type !== MajorType.Text) {
        throw new TypeError(`Cannot convert CBOR to Text: expected Text type, got ${MajorType[this.type]}`);
      }
      return this.value;
    },
    toArray(this: Cbor): Cbor[] {
      if (this.type !== MajorType.Array) {
        throw new TypeError(`Cannot convert CBOR to Array: expected Array type, got ${MajorType[this.type]}`);
      }
      return this.value;
    },
    toMap(this: Cbor): CborMap {
      if (this.type !== MajorType.Map) {
        throw new TypeError(`Cannot convert CBOR to Map: expected Map type, got ${MajorType[this.type]}`);
      }
      return this.value;
    },
    toTagged(this: Cbor): [Tag, Cbor] {
      if (this.type !== MajorType.Tagged) {
        throw new TypeError(`Cannot convert CBOR to Tagged: expected Tagged type, got ${MajorType[this.type]}`);
      }
      const tag: Tag = { value: this.tag, name: `tag-${this.tag}` };
      return [tag, this.value];
    },
    toBool(this: Cbor): boolean {
      const result = this.asBool();
      if (result === undefined) {
        throw new TypeError(`Cannot convert CBOR to boolean: expected Simple(True/False) type, got ${MajorType[this.type]}`);
      }
      return result;
    },
    toInteger(this: Cbor): number | bigint {
      const result = this.asInteger();
      if (result === undefined) {
        throw new TypeError(`Cannot convert CBOR to integer: expected Unsigned or Negative type, got ${MajorType[this.type]}`);
      }
      return result;
    },
    toNumber(this: Cbor): number | bigint {
      const result = this.asNumber();
      if (result === undefined) {
        throw new TypeError(`Cannot convert CBOR to number: expected Unsigned, Negative, or Float type, got ${MajorType[this.type]}`);
      }
      return result;
    },
    toSimpleValue(this: Cbor): Simple {
      if (this.type !== MajorType.Simple) {
        throw new TypeError(`Cannot convert CBOR to Simple: expected Simple type, got ${MajorType[this.type]}`);
      }
      return this.value;
    },
    expectTag(this: Cbor, expectedTag: CborNumber | Tag): Cbor {
      if (this.type !== MajorType.Tagged) {
        throw new CborError({ type: 'WrongType' });
      }
      const expectedValue = typeof expectedTag === 'object' && 'value' in expectedTag ? expectedTag.value : expectedTag;
      if (this.tag !== expectedValue) {
        throw new CborError({ type: 'Custom', message: `Wrong tag: expected ${expectedValue}, got ${this.tag}` });
      }
      return this.value;
    },

    // Advanced operations
    walk<State>(this: Cbor, initialState: State, visitor: Visitor<State>): State {
      // Use lazy import to avoid circular dependency
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef, @typescript-eslint/no-unsafe-assignment
      const { walk: walkFn } = require('./walk');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
      return walkFn(this, initialState, visitor);
    },
    validateTag(this: Cbor, expectedTags: Tag[]): Tag {
      if (this.type !== MajorType.Tagged) {
        throw new CborError({ type: 'WrongType' });
      }
      const expectedValues = expectedTags.map(t => t.value);
      const tagValue = this.tag;
      const matchingTag = expectedTags.find(t => t.value === tagValue);
      if (matchingTag === undefined) {
        const expectedStr = expectedValues.join(' or ');
        throw new CborError({ type: 'Custom', message: `Wrong tag: expected ${expectedStr}, got ${tagValue}` });
      }
      return matchingTag;
    },
    untagged(this: Cbor): Cbor {
      if (this.type !== MajorType.Tagged) {
        throw new CborError({ type: 'WrongType' });
      }
      return this.value;
    },
  });
}

// ============================================================================
// Cbor Namespace - Static Constants and Factory Methods
// ============================================================================

/**
 * CBOR constants and helper methods.
 *
 * Provides constants for common simple values (False, True, Null) and static methods
 * matching the Rust CBOR API for encoding/decoding.
 */
// eslint-disable-next-line no-redeclare
export const Cbor = {
  // Static CBOR simple values (matching Rust naming) - with methods attached
  False: attachMethods({ isCbor: true, type: MajorType.Simple, value: { type: 'False' } }),
  True: attachMethods({ isCbor: true, type: MajorType.Simple, value: { type: 'True' } }),
  Null: attachMethods({ isCbor: true, type: MajorType.Simple, value: { type: 'Null' } }),
  NaN: attachMethods({ isCbor: true, type: MajorType.Simple, value: { type: 'Float', value: NaN } }),

  // ============================================================================
  // Static Factory/Decoding Methods (matches Rust CBOR static methods)
  // ============================================================================

  /**
   * Creates a CBOR value from any JavaScript value.
   *
   * Matches Rust's `CBOR::from()` behavior for various types.
   *
   * @param value - Any JavaScript value (number, string, boolean, null, array, object, etc.)
   * @returns A CBOR symbolic representation with instance methods
   */
  from(value: CborEncodable): Cbor {
    return cbor(value);
  },

  /**
   * Decodes binary data into CBOR symbolic representation.
   *
   * Matches Rust's `CBOR::try_from_data()` method.
   *
   * @param data - The binary data to decode
   * @returns A CBOR value with instance methods
   * @throws Error if the data is not valid CBOR or violates dCBOR encoding rules
   */
  tryFromData(data: Uint8Array): Cbor {
    return decodeCbor(data);
  },

  /**
   * Decodes a hexadecimal string into CBOR symbolic representation.
   *
   * Matches Rust's `CBOR::try_from_hex()` method.
   *
   * @param hex - A string containing hexadecimal characters
   * @returns A CBOR value with instance methods
   * @throws Error if the hex string is invalid or the resulting data is not valid dCBOR
   */
  tryFromHex(hex: string): Cbor {
    const data = hexToBytes(hex);
    return this.tryFromData(data);
  },
};

