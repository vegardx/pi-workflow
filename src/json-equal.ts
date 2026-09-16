/**
 * Realm-agnostic structural equality for JSON values.
 *
 * `node:util.isDeepStrictEqual` compares prototypes, so a plain object or
 * array created in another realm (a `vm` context, the dynamic workflow
 * sandbox) never equals its own `JSON.parse(JSON.stringify(value))` copy.
 * This comparison recognises plain arrays and plain objects by shape rather
 * than by prototype identity, while still rejecting everything the strict
 * round-trip check rejected: `undefined` and function values, symbol-keyed
 * properties, `NaN`/`Infinity`, `-0` versus `0`, sparse arrays, arrays with
 * extra properties, and any non-plain object (Date, Map, Set, RegExp, boxed
 * primitives, typed arrays, class instances, null-prototype objects).
 */

/** Plain objects in any realm: the prototype is that realm's `Object.prototype`. */
function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype !== null && Object.getPrototypeOf(prototype) === null;
}

/** Plain arrays in any realm: the prototype is that realm's `Array.prototype`. */
function isPlainArray(value: unknown): value is readonly unknown[] {
	if (!Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return (
		prototype !== null &&
		isPlainObject(prototype) &&
		Object.keys(value).length === value.length
	);
}

function hasEnumerableSymbolKeys(value: object): boolean {
	return Object.getOwnPropertySymbols(value).some((symbol) =>
		Object.prototype.propertyIsEnumerable.call(value, symbol),
	);
}

/**
 * True when `left` and `right` are the same JSON value structurally: primitives
 * by `Object.is`, arrays element-wise, plain objects by own enumerable string
 * keys. Prototype identity and realm are irrelevant; non-JSON shapes are never
 * equal to anything. Terminates on cycles because at least one side must be
 * finite for the pair to be equal.
 */
export function jsonStructurallyEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return left !== undefined;
	if (typeof left !== "object" || typeof right !== "object") return false;
	if (left === null || right === null) return false;
	if (isPlainArray(left)) {
		if (!isPlainArray(right) || left.length !== right.length) return false;
		return left.every((entry, index) =>
			jsonStructurallyEqual(entry, right[index]),
		);
	}
	if (isPlainArray(right)) return false;
	if (
		!isPlainObject(left) ||
		!isPlainObject(right) ||
		hasEnumerableSymbolKeys(left) ||
		hasEnumerableSymbolKeys(right)
	) {
		return false;
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	const entries = left as Record<string, unknown>;
	const others = right as Record<string, unknown>;
	return leftKeys.every(
		(key) =>
			Object.hasOwn(right, key) &&
			jsonStructurallyEqual(entries[key], others[key]),
	);
}

/**
 * Whether `value` survives a JSON round trip unchanged, regardless of the
 * realm that created it. Drop-in for
 * `isDeepStrictEqual(value, JSON.parse(JSON.stringify(value)))` at sites that
 * may see sandbox-realm values; callers keep their own serialization errors.
 */
export function isLosslessJsonRoundTrip(
	value: unknown,
	roundTrip: unknown,
): boolean {
	return jsonStructurallyEqual(value, roundTrip);
}
