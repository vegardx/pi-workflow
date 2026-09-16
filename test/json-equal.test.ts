import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
	isLosslessJsonRoundTrip,
	jsonStructurallyEqual,
} from "../src/json-equal.js";

function roundTrip(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

describe("realm-agnostic JSON equality", () => {
	it("compares same-realm JSON values structurally", () => {
		const value = { a: [1, { b: 2 }], c: "x", d: null, e: true };
		expect(jsonStructurallyEqual(value, roundTrip(value))).toBe(true);
		expect(jsonStructurallyEqual(value, { ...value, c: "y" })).toBe(false);
		expect(jsonStructurallyEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(jsonStructurallyEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
		expect(jsonStructurallyEqual([1, 2], [1, 2, 3])).toBe(false);
		expect(jsonStructurallyEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
		expect(jsonStructurallyEqual({ 0: 1 }, [1])).toBe(false);
		expect(jsonStructurallyEqual(null, {})).toBe(false);
		expect(jsonStructurallyEqual({}, null)).toBe(false);
		expect(jsonStructurallyEqual("1", 1)).toBe(false);
		expect(jsonStructurallyEqual(1, 1)).toBe(true);
		expect(jsonStructurallyEqual(null, null)).toBe(true);
		expect(jsonStructurallyEqual(-0, 0)).toBe(false);
	});

	it("treats a vm-realm value as equal to its worker-realm JSON copy", () => {
		const foreign = vm.runInNewContext("({ a: [1, { b: 2 }] })") as object;
		expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
		expect(jsonStructurallyEqual(foreign, roundTrip(foreign))).toBe(true);
		expect(jsonStructurallyEqual(roundTrip(foreign), foreign)).toBe(true);
		expect(jsonStructurallyEqual(foreign, { a: [1, { b: 2 }] })).toBe(true);
		expect(jsonStructurallyEqual(foreign, { a: [1, { b: 3 }] })).toBe(false);
		expect(isLosslessJsonRoundTrip(foreign, roundTrip(foreign))).toBe(true);
		const foreignArray = vm.runInNewContext("[1, 'two', [3], { four: 4 }]");
		expect(isLosslessJsonRoundTrip(foreignArray, roundTrip(foreignArray))).toBe(
			true,
		);
	});

	it("rejects every shape the strict round-trip check rejected", () => {
		const rejected: readonly unknown[] = [
			{ a: undefined },
			[undefined],
			{ f() {} },
			[() => 1],
			{ [Symbol("s")]: 1, a: 1 },
			{ n: Number.NaN },
			{ n: Number.POSITIVE_INFINITY },
			[Number.NEGATIVE_INFINITY],
			{ z: -0 },
			{ d: new Date(0) },
			{ m: new Map() },
			{ s: new Set() },
			{ r: /x/ },
			{ b: new Number(1) },
			{ u: new Uint8Array(2) },
			{ i: new (class Point {})() },
			{ o: Object.assign(Object.create(null), { a: 1 }) },
			// biome-ignore lint/suspicious/noSparseArray: the hole is the point.
			[1, , 3],
			Object.assign([1], { extra: 2 }),
			new (class List extends Array {})(1),
			{ toJSON: () => ({ a: 1 }) },
		];
		for (const value of rejected) {
			expect(isLosslessJsonRoundTrip(value, roundTrip(value))).toBe(false);
		}
		// bigint and cycles never reach the comparison: `JSON.stringify` throws.
		expect(() => JSON.stringify({ big: 1n })).toThrow(TypeError);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => JSON.stringify(cyclic)).toThrow(TypeError);
		// A cyclic left side against a finite right side terminates as unequal.
		expect(jsonStructurallyEqual(cyclic, { self: {} })).toBe(false);
		// Foreign-realm non-plain objects are rejected too.
		expect(
			isLosslessJsonRoundTrip(
				vm.runInNewContext("({ d: new Date(0) })"),
				roundTrip(vm.runInNewContext("({ d: new Date(0) })")),
			),
		).toBe(false);
		expect(
			isLosslessJsonRoundTrip(vm.runInNewContext("({ m: new Map() })"), {
				m: {},
			}),
		).toBe(false);
	});

	it("never equates undefined with anything, including itself", () => {
		expect(jsonStructurallyEqual(undefined, undefined)).toBe(false);
		expect(jsonStructurallyEqual(undefined, null)).toBe(false);
		expect(jsonStructurallyEqual({ a: undefined }, {})).toBe(false);
	});
});
