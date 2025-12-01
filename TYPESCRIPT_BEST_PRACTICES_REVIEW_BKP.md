# TypeScript Best Practices Review

## Executive Summary

The bc-dcbor-ts codebase demonstrates **strong TypeScript fundamentals** with excellent type safety, discriminated unions, and modern syntax. However, there are opportunities to adopt more idiomatic TypeScript patterns, improve consistency, and leverage advanced TypeScript features.

**Overall Grade: B+ (Very Good with room for improvement)**

---

## 1. Error Handling Strategy ⚠️ HIGH PRIORITY

### Current State

The codebase has an excellent foundation with the `Result<T>` type and discriminated union `Error` type:

```typescript
// error.ts - Great discriminated union!
export type Error =
  | { type: 'Underrun' }
  | { type: 'UnsupportedHeaderValue'; value: number }
  | { type: 'NonCanonicalNumeric' }
  // ... more variants

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };
```

### Problem

**The `Result<T>` type is defined but rarely used.** Most functions throw plain JavaScript `Error` objects:

```typescript
// decode.ts:10 - throws string instead of using Result
throw new Error(`Extra bytes after CBOR: ${remaining}`);

// varint.ts:11 - throws string
throw new Error("Value out of range");

// map.ts:113 - throws string
throw new Error('MissingMapKey');
```

### Recommendation

**Option A: Adopt Result<T> Pattern (Rust-Style)**

Make fallible operations return `Result<T>` instead of throwing:

```typescript
// BEFORE
export function decodeCbor(data: Uint8Array): Cbor {
  // throws on error
}

// AFTER
export function decodeCbor(data: Uint8Array): Result<Cbor> {
  try {
    const {cbor, len} = decodeCborInternal(...);
    if (remaining !== 0) {
      return Err({ type: 'UnusedData', count: remaining });
    }
    return Ok(cbor);
  } catch (e) {
    return Err({ type: 'Underrun' });
  }
}
```

**Option B: Typed Error Classes (More TypeScript-Idiomatic)**

Create typed error classes that extend `Error`:

```typescript
// error.ts
export class CborError extends Error {
  constructor(
    public readonly errorType: Error,
    message?: string
  ) {
    super(message ?? errorToString(errorType));
    this.name = 'CborError';
  }
}

// Usage
throw new CborError({ type: 'Underrun' });
```

**Option C: Hybrid Approach (Recommended)**

- Use `Result<T>` for expected errors (decoding, validation)
- Use typed exceptions for programmer errors (invalid arguments)
- Keep `throwError()` helper for backward compatibility

```typescript
// Decoding - use Result<T>
export function decodeCbor(data: Uint8Array): Result<Cbor> { ... }

// Validation - use Result<T>
export function validateTag(cbor: Cbor, tags: Tag[]): Result<Tag> { ... }

// Programmer errors - throw immediately
export function encodeVarInt(value: CborNumber, majorType: MajorType): Uint8Array {
  if (value < 0) {
    throw new TypeError("Value must be non-negative");
  }
  // ...
}
```

---

## 2. Type Assertions and Type Narrowing ⚠️ MEDIUM PRIORITY

### Current Issues

**Unnecessary type assertions:**

```typescript
// simple.ts:114 - Unnecessary cast
const bFloat = b as { type: 'Float'; value: number };
```

**Better approach using type narrowing:**

```typescript
// BEFORE
const bFloat = b as { type: 'Float'; value: number };

// AFTER - Type narrowing with discriminated union
if (b.type === 'Float') {
  // TypeScript knows b is { type: 'Float'; value: number } here
  const v2 = b.value;
}
```

### Recommendation

**Eliminate `as` casts by leveraging TypeScript's type narrowing:**

```typescript
// Pattern 1: Use discriminated unions properly
function simpleEquals(a: Simple, b: Simple): boolean {
  if (a.type !== b.type) return false;

  switch (a.type) {
    case 'Float':
      // TypeScript knows both a and b are Float here
      return a.value === b.value ||
        (Number.isNaN(a.value) && Number.isNaN(b.value));
    // ...
  }
}

// Pattern 2: Use type predicates for custom guards
function isFloatSimple(simple: Simple): simple is { type: 'Float'; value: number } {
  return simple.type === 'Float';
}
```

---

## 3. Const Assertions and Immutability 📌 MEDIUM PRIORITY

### Current State

Good use of `as const` in some places:

```typescript
// decode.ts:116 - Good!
const cborObj = { isCbor: true, type: MajorType.Unsigned, value } as const;
```

### Recommendation

**Expand const assertions and readonly usage:**

```typescript
// 1. Mark more properties as readonly
export interface Tag {
  readonly value: CborNumber;
  readonly name?: string;
}

// 2. Use const assertions for literal objects
const CBOR_CONSTANTS = {
  NAN: new Uint8Array([0xf9, 0x7e, 0x00]),
  FALSE: 20,
  TRUE: 21,
  NULL: 22,
} as const;

// 3. Readonly arrays where appropriate
export interface CborArrayType {
  readonly type: MajorType.Array;
  readonly value: readonly Cbor[];  // Make array readonly
}

// 4. Readonly class properties
export class TagsStore {
  readonly #tagsByValue: ReadonlyMap<string, Tag>;
}
```

---

## 4. Function Consistency 🎯 LOW PRIORITY

### Current State

Mix of function declarations and arrow functions:

```typescript
// Function declarations
export function createTag(value: CborNumber, name?: string): Tag {
  return { value, name };
}

// Arrow functions would be more consistent
export const createTag = (value: CborNumber, name?: string): Tag => {
  return { value, name };
};
```

### Recommendation

**Standardize on arrow functions for consistency:**

Benefits:
- Lexical `this` binding (prevents bugs)
- More consistent with modern JavaScript/TypeScript
- Better for higher-order functions

```typescript
// RECOMMENDED PATTERN
export const createTag = (value: CborNumber, name?: string): Tag => ({
  value,
  name
});

// Use function declarations ONLY for:
// 1. Functions that need hoisting
// 2. Recursive functions that reference themselves
// 3. Generator functions
```

---

## 5. Optional Chaining and Nullish Coalescing ✅ LOW PRIORITY

### Current State

Already uses `??` (nullish coalescing):

```typescript
// tags-store.ts:262 - Good!
globalTagsStore ??= new TagsStore();

// tags-store.ts:179 - Good!
return this.assignedNameForTag(tag) ?? tag.value.toString();
```

### Recommendation

**Expand usage of optional chaining (`?.`) where appropriate:**

```typescript
// BEFORE
const name = tag !== undefined ? tag.name : undefined;

// AFTER
const name = tag?.name;

// BEFORE
if (stored && stored.name) {
  return stored.name;
}

// AFTER
return stored?.name;
```

---

## 6. Enum vs Union Types 🔄 LOW PRIORITY

### Current Issue

Uses `enum` for `MajorType`:

```typescript
// Enums have runtime overhead and less type safety
export enum MajorType {
  Unsigned = 0,
  Negative = 1,
  // ...
}
```

### Recommendation

**Consider replacing enums with const objects and union types:**

```typescript
// CURRENT (enum)
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

// ALTERNATIVE (const object + union type)
export const MajorType = {
  Unsigned: 0,
  Negative: 1,
  ByteString: 2,
  Text: 3,
  Array: 4,
  Map: 5,
  Tagged: 6,
  Simple: 7,
} as const;

export type MajorType = typeof MajorType[keyof typeof MajorType];
```

**Benefits:**
- Better tree-shaking (unused values eliminated)
- No runtime overhead
- More type-safe (exact type instead of number)
- Works better with discriminated unions

**Trade-offs:**
- Slightly more verbose
- Requires TypeScript 3.4+
- May require refactoring existing switch statements

**Verdict:** Keep enum for now (breaking change), but consider for v3.0.

---

## 7. Return Type Annotations ✅ GOOD

### Current State

Most functions have explicit return types (excellent!):

```typescript
// Good examples throughout
export function simpleName(simple: Simple): string { ... }
export function hasFractionalPart(n: number): boolean { ... }
```

### Minor Improvements

Add return types to a few remaining functions:

```typescript
// varint.ts:4 - Add explicit return type
function typeBits(t: MajorType): number {
  return t << 5;
}
```

---

## 8. Type Predicates for Type Guards 📋 MEDIUM PRIORITY

### Current State

Has some type predicates:

```typescript
// simple.ts:63 - Good!
export function isFloat(simple: Simple): simple is { type: 'Float'; value: number } {
  return simple.type === 'Float';
}
```

### Recommendation

**Add more type predicates throughout codebase:**

```typescript
// conveniences.ts - Convert boolean returns to type predicates

// BEFORE
export function isArray(cbor: Cbor): boolean {
  return cbor.type === MajorType.Array;
}

// AFTER
export function isArray(cbor: Cbor): cbor is CborArrayType {
  return cbor.type === MajorType.Array;
}

// Now TypeScript knows the type after the guard
if (isArray(value)) {
  // value is CborArrayType here
  const length = value.value.length;  // Type-safe!
}
```

---

## 9. JSDoc Improvements 📚 LOW PRIORITY

### Current State

Excellent JSDoc coverage! Examples:

```typescript
/**
 * Creates a new `CborDate` from year, month, and day components.
 *
 * @param year - The year component (e.g., 2023)
 * @param month - The month component (1-12)
 * @param day - The day component (1-31)
 * @returns A new `CborDate` instance
 * @example ...
 * @throws Error if the provided components do not form a valid date.
 */
```

### Minor Improvements

**Add `@throws` tags consistently:**

```typescript
// BEFORE
/**
 * Extract unsigned integer value, throwing if type doesn't match.
 */
export function expectUnsigned(cbor: Cbor): number | bigint {
  // throws but not documented
}

// AFTER
/**
 * Extract unsigned integer value, throwing if type doesn't match.
 *
 * @throws {Error} If cbor is not an unsigned integer type
 */
export function expectUnsigned(cbor: Cbor): number | bigint {
  // ...
}
```

---

## 10. Utility Types Usage 🛠️ LOW PRIORITY

### Recommendation

**Leverage built-in TypeScript utility types:**

```typescript
// 1. Partial for optional fields
interface CborMapOptions {
  comparator?: (a: Uint8Array, b: Uint8Array) => number;
  initialCapacity?: number;
}
// Can simplify to
type CborMapOptions = Partial<{
  comparator: (a: Uint8Array, b: Uint8Array) => number;
  initialCapacity: number;
}>;

// 2. Readonly for immutable interfaces
type ImmutableTag = Readonly<Tag>;

// 3. Pick/Omit for derived types
type TagValue = Pick<Tag, 'value'>;
type AnonymousTag = Omit<Tag, 'name'>;

// 4. ReturnType for extracting return types
type CborValue = ReturnType<typeof cbor>;

// 5. Parameters for extracting parameter types
type CreateTagParams = Parameters<typeof createTag>;
```

---

## 11. Async/Promise Patterns ℹ️ NOT APPLICABLE

The library is synchronous by design, which is appropriate for CBOR encoding/decoding. No changes needed.

---

## 12. Naming Conventions ✅ MOSTLY GOOD

### Current State

- **Classes/Types:** PascalCase ✅
- **Functions/Variables:** camelCase ✅
- **Private fields:** `#field` prefix ✅
- **Constants:** UPPER_SNAKE_CASE ✅

### Minor Inconsistencies

```typescript
// Inconsistent casing for abbreviations
cbor() // lowercase
Cbor // uppercase
CborMap // uppercase

// Recommendation: Be consistent
// If acronym is at start: Pascal/camelCase it normally
// If acronym is in middle: keep it uppercase
```

---

## 13. Parameter Properties 🎯 LOW PRIORITY

### Opportunity

TypeScript allows combining constructor parameters and property declarations:

```typescript
// BEFORE
export class CborDate {
  #datetime: Date;

  private constructor() {
    this.#datetime = new Date();
  }
}

// AFTER (if datetime wasn't private field)
export class CborDate {
  constructor(private datetime: Date = new Date()) {}
}
```

**Note:** Doesn't work with `#private` fields, so current approach is fine.

---

## 14. Strict TypeScript Configuration ⚙️ HIGH PRIORITY

### Recommendation

Ensure `tsconfig.json` has strict mode enabled:

```json
{
  "compilerOptions": {
    "strict": true,  // Enables all strict type checking options
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "alwaysStrict": true,

    // Additional recommended flags
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,  // Makes array access safer
    "exactOptionalPropertyTypes": true  // Stricter optional properties
  }
}
```

---

## 15. Avoiding Dynamic `require()` 🔧 MEDIUM PRIORITY

### Current Issue

Uses dynamic requires to avoid circular dependencies:

```typescript
// cbor.ts:385
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hexOpt } = require('./dump');
```

### Recommendation

**Refactor to eliminate circular dependencies:**

**Option A: Create shared types module**

```typescript
// types.ts - No imports, just types
export type Cbor = ...;
export type CborMethods = ...;

// cbor.ts - Imports only types
import type { Cbor } from './types';

// dump.ts - Imports only types
import type { Cbor } from './types';
```

**Option B: Dependency injection**

```typescript
// Make functions accept dependencies
export const attachMethods = (hexOptFn: typeof hexOpt) => (obj: CborObj) => {
  // Use hexOptFn instead of importing
};
```

**Option C: Lazy module pattern**

```typescript
// Create a lazily-loaded module reference
let dumpModule: typeof import('./dump') | undefined;

function getDumpModule() {
  if (!dumpModule) {
    dumpModule = require('./dump');
  }
  return dumpModule;
}
```

---

## Priority Summary

### 🚨 HIGH PRIORITY
1. **Error Handling Strategy** - Decide on Result<T> vs typed exceptions
2. **Strict TypeScript Config** - Ensure all strict flags enabled

### ⚠️ MEDIUM PRIORITY
3. **Type Assertions** - Replace `as` with type narrowing
4. **Const Assertions** - Expand readonly and const usage
5. **Type Predicates** - Add more type guards
6. **Circular Dependencies** - Eliminate dynamic requires

### 📋 LOW PRIORITY
7. **Function Consistency** - Standardize on arrow functions
8. **Optional Chaining** - Expand `?.` usage
9. **Enum vs Union** - Consider for v3.0 (breaking change)
10. **JSDoc @throws** - Add consistently
11. **Utility Types** - Use more built-in types
12. **Naming Conventions** - Minor acronym consistency

---

## Recommended Action Plan

### Phase 1: Foundation (Week 1)
1. ✅ Review and update `tsconfig.json` for strict mode
2. ✅ Document error handling strategy decision
3. ✅ Add type predicates to type guard functions

### Phase 2: Consistency (Week 2-3)
4. ✅ Replace type assertions with type narrowing
5. ✅ Expand const assertions and readonly usage
6. ✅ Standardize function declarations

### Phase 3: Quality (Week 4)
7. ✅ Refactor circular dependencies
8. ✅ Add @throws JSDoc tags
9. ✅ Expand optional chaining usage

### Phase 4: Consider for Next Major Version
10. 🔄 Enum to union type migration
11. 🔄 Breaking API changes if needed

---

## Conclusion

The bc-dcbor-ts codebase demonstrates **strong TypeScript fundamentals** with:
- ✅ Excellent discriminated unions
- ✅ Good type safety
- ✅ Modern private fields (`#`)
- ✅ Comprehensive JSDoc
- ✅ Strong separation of concerns

Main areas for improvement:
- ⚠️ Error handling consistency (Result<T> vs exceptions)
- ⚠️ Type assertion elimination
- ⚠️ Circular dependency resolution

**Overall:** This is high-quality TypeScript code with clear opportunities for incremental improvements following modern best practices.
