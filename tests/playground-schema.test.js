const test = require("node:test");
const assert = require("node:assert/strict");
const { WireCodec } = require("../src/core/Playground/WireCodec");

const body = () => ({ contents: [{ parts: [{ text: "Hi" }], role: "user" }] });
const property = (schema, name) => schema[6].find(([key]) => key === name)[1];
const freeze = value => {
    if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
};

// Check the accepted values of union/composition output independently of its normalization layout.
const accepts = (schema, value) => {
    const types = {
        1: () => typeof value === "string",
        2: () => typeof value === "number",
        3: () => Number.isInteger(value),
        4: () => typeof value === "boolean",
        5: () => Array.isArray(value),
        6: () => value !== null && typeof value === "object" && !Array.isArray(value),
    };
    if (schema[0] && !types[schema[0]]() && !(value === null && schema[3])) return false;
    if (schema[4] && !schema[4].includes(value)) return false;
    if (schema[16] && schema[16].filter(branch => accepts(branch, value)).length !== 1) return false;
    if (schema[17] && !schema[17].some(branch => accepts(branch, value))) return false;
    if (schema[18] && !schema[18].every(branch => accepts(branch, value))) return false;
    if (schema[19] && accepts(schema[19], value)) return false;
    if (typeof value === "string") {
        if (schema[12] != null && value.length < schema[12]) return false;
        if (schema[13] != null && value.length > schema[13]) return false;
        if (schema[14] && !new RegExp(schema[14]).test(value)) return false;
    }
    if (typeof value === "number") {
        if (schema[10] != null && value < schema[10]) return false;
        if (schema[11] != null && value > schema[11]) return false;
    }
    if (Array.isArray(value)) {
        if (schema[5] && !value.every(item => accepts(schema[5], item))) return false;
        if (schema[20] != null && value.length > schema[20]) return false;
        if (schema[21] != null && value.length < schema[21]) return false;
    }
    return true;
};

const rejectsAt = (operation, ...pathParts) =>
    assert.throws(operation, error => {
        assert.equal(error.status, 400);
        assert.equal(error.retryable, false);
        assert.match(error.message, /^Playground:/);
        for (const part of pathParts) assert.ok(error.message.includes(part), error.message);
        return true;
    });

test("all existing scalar schema types retain their wire enum", () => {
    for (const [type, code] of [
        ["string", 1],
        ["number", 2],
        ["integer", 3],
        ["boolean", 4],
        ["array", 5],
        ["object", 6],
    ]) {
        assert.equal(WireCodec.schema({ type })[0], code);
        assert.equal(WireCodec.schema({ type: type.toUpperCase() })[0], code);
    }
});

test("pure-null schemas accept only null using supported protocol types", () => {
    for (const type of ["null", "NULL", ["null", "NULL"]]) {
        const wire = WireCodec.schema({ type });
        assert.equal(accepts(wire, null), true);
        for (const value of ["", 0, false, {}, []]) assert.equal(accepts(wire, value), false);
    }
});

test("pure-null normalization retains existing not and allOf restrictions", () => {
    for (const schema of [
        { not: { type: "null" }, type: "null" },
        { allOf: [{ type: "number" }], not: { type: "boolean" }, type: "null" },
    ]) {
        const wire = WireCodec.schema(schema);
        for (const value of [null, "", 0, false, {}, []]) assert.equal(accepts(wire, value), false);
    }
});

test("nullable type arrays accept null without admitting other scalar types", () => {
    for (const type of [
        ["string", "null"],
        ["NULL", "STRING"],
        ["string", "string", "null"],
    ]) {
        const wire = WireCodec.schema({ description: "Optional label", minLength: 2, type });
        assert.equal(wire[2], "Optional label");
        assert.equal(accepts(wire, null), true);
        assert.equal(accepts(wire, "ok"), true);
        for (const value of ["x", 4, false, {}, []]) assert.equal(accepts(wire, value), false);
    }
});

test("multi-type arrays preserve constraints shared by their branches", () => {
    const wire = WireCodec.schema({
        description: "Label or score",
        maximum: 9,
        maxLength: 4,
        minimum: 3,
        minLength: 2,
        type: ["string", "number", "null"],
    });
    assert.ok(wire[2] === "Label or score" || wire[17]?.every(branch => branch[2] === "Label or score"));
    for (const value of [null, "ok", 3, 9]) assert.equal(accepts(wire, value), true);
    for (const value of ["x", "abcde", 2, 10, false, {}, []]) assert.equal(accepts(wire, value), false);
});

test("union types intersect with existing anyOf instead of replacing or widening it", () => {
    const wire = WireCodec.schema({
        anyOf: [{ minLength: 2, type: "string" }, { minimum: 5, type: "number" }, { type: "boolean" }],
        type: ["string", "number"],
    });
    for (const value of ["ok", 5]) assert.equal(accepts(wire, value), true);
    for (const value of ["x", 4, true, null, {}]) assert.equal(accepts(wire, value), false);
});

test("nullable unions still apply sibling enum and anyOf restrictions", () => {
    for (const schema of [
        { enum: ["yes"], type: ["string", "null"] },
        { anyOf: [{ minLength: 3, type: "string" }], type: ["string", "null"] },
    ]) {
        const wire = WireCodec.schema(schema);
        assert.equal(accepts(wire, "yes"), true);
        for (const value of [null, "x", 4, false]) assert.equal(accepts(wire, value), false);
    }
});

test("nullable true adds null to mixed-type unions without bypassing sibling restrictions", () => {
    const schema = { nullable: true, type: ["string", "number"] };
    const wire = WireCodec.schema(schema);
    for (const value of [null, "yes", 3]) assert.equal(accepts(wire, value), true);
    for (const value of [true, [], {}]) assert.equal(accepts(wire, value), false);
    for (const restricted of [
        { ...schema, enum: ["yes"] },
        { ...schema, anyOf: [{ minLength: 3, type: "string" }] },
    ]) {
        const encoded = WireCodec.schema(restricted);
        assert.equal(accepts(encoded, "yes"), true);
        for (const value of [null, "x", 3, true]) assert.equal(accepts(encoded, value), false);
    }
});

test("nested unions keep shared constraints without multiplying their serialized size", () => {
    const nested = depth => {
        let schema = { description: "leaf-marker", minLength: 2, type: "string" };
        for (let index = 0; index < depth; index++)
            schema = { items: schema, maxItems: 2, minItems: 1, minLength: 2, type: ["string", "array"] };
        return WireCodec.schema(schema);
    };
    const shallow = JSON.stringify(nested(6));
    const wire = nested(12);
    const deep = JSON.stringify(wire);
    assert.ok(deep.length < shallow.length * 2.5, `Schema grew from ${shallow.length} to ${deep.length} bytes`);
    assert.equal(deep.split("leaf-marker").length - 1, 1);
    let valid = "ok";
    let invalid = "x";
    let empty = [];
    for (let index = 0; index < 12; index++) {
        valid = [valid];
        invalid = [invalid];
        empty = [empty];
    }
    assert.equal(accepts(wire, valid), true);
    for (const value of [invalid, empty, [], false, null]) assert.equal(accepts(wire, value), false);
});

test("union type constraints retain an existing anyOf and allOf intersection", () => {
    const wire = WireCodec.schema({
        allOf: [{ not: { type: "boolean" } }],
        anyOf: [{ minLength: 3, type: "string" }, { minimum: 3, type: "number" }, { type: "boolean" }],
        type: ["string", "boolean"],
    });
    assert.equal(accepts(wire, "yes"), true);
    for (const value of ["no", true, 3, null]) assert.equal(accepts(wire, value), false);
});

test("single-member type arrays retain their type and pure-null arrays remain null-only", () => {
    assert.equal(WireCodec.schema({ type: ["integer"] })[0], 3);
    const wire = WireCodec.schema({ type: ["null", "NULL"] });
    assert.equal(accepts(wire, null), true);
    assert.equal(accepts(wire, "null"), false);
});

test("nested anyOf null branches work inside properties and array items", () => {
    const wire = WireCodec.schema({
        properties: {
            entries: {
                items: { anyOf: [{ minLength: 2, type: "string" }, { type: "null" }] },
                maxItems: 5,
                minItems: 1,
                type: "array",
            },
        },
        required: ["entries"],
        type: "object",
    });
    const entries = property(wire, "entries");
    assert.equal(wire[0], 6);
    assert.deepEqual(wire[7], ["entries"]);
    assert.equal(entries[0], 5);
    assert.equal(entries[20], 5);
    assert.equal(entries[21], 1);
    assert.equal(accepts(entries[5], null), true);
    assert.equal(accepts(entries[5], "ok"), true);
    assert.equal(accepts(entries[5], "x"), false);
    assert.equal(accepts(entries[5], 3), false);
});

test("schemas using only compositions never acquire an implicit string restriction", () => {
    for (const [schema, index, accepted, rejected] of [
        [{ oneOf: [{ type: "number" }, { type: "boolean" }] }, 16, [5, true], ["5", null]],
        [{ anyOf: [{ type: "number" }, { type: "null" }] }, 17, [5, null], ["5", true]],
        [{ allOf: [{ type: "number" }, { minimum: 2, type: "number" }] }, 18, [2, 5], [1, "5"]],
        [{ not: { type: "null" } }, 19, [5, true, "ok", {}], [null]],
    ]) {
        const wire = WireCodec.schema(schema);
        assert.equal(wire[0], undefined);
        assert.ok(wire[index]);
        for (const value of accepted) assert.equal(accepts(wire, value), true);
        for (const value of rejected) assert.equal(accepts(wire, value), false);
    }
});

test("existing schema fields and snake-case constraints retain their protocol positions", () => {
    const wire = WireCodec.schema({
        description: "Lookup",
        example: { label: "AA" },
        max_properties: 2,
        min_properties: 1,
        nullable: false,
        properties: {
            label: {
                enum: ["AA", "BB"],
                format: "custom",
                max_length: 3,
                min_length: 2,
                pattern: "^[A-Z]+$",
                type: "string",
            },
        },
        property_ordering: ["label"],
        required: ["label"],
        type: "object",
    });
    assert.equal(wire[2], "Lookup");
    assert.equal(wire[3], false);
    assert.deepEqual(wire[7], ["label"]);
    assert.equal(wire[8], 1);
    assert.equal(wire[9], 2);
    assert.deepEqual(WireCodec.decodeValue(wire[15]), { label: "AA" });
    assert.deepEqual(wire[22], ["label"]);
    const label = property(wire, "label");
    assert.equal(label[1], "custom");
    assert.deepEqual(label[4], ["AA", "BB"]);
    assert.equal(label[12], 2);
    assert.equal(label[13], 3);
    assert.equal(label[14], "^[A-Z]+$");
});

test("property and item inference stays compatible with existing schemas", () => {
    assert.equal(WireCodec.schema({ properties: { label: { type: "string" } } })[0], 6);
    assert.equal(WireCodec.schema({ items: { type: "number" } })[0], 5);
});

test("normalization does not mutate a frozen schema reused by tools and structured output", () => {
    const schema = freeze({
        properties: { label: { anyOf: [{ type: "null" }, { type: ["string", "number"] }] } },
        required: ["label"],
        type: "object",
    });
    const before = JSON.stringify(schema);
    const request = {
        ...body(),
        generationConfig: { responseMimeType: "application/json", responseSchema: schema },
        tools: [{ functionDeclarations: [{ name: "lookup", parameters: schema }] }],
    };
    const first = WireCodec.encode("gemini-4-argon", request);
    const second = WireCodec.encode("gemini-4-argon", request);
    assert.equal(JSON.stringify(schema), before);
    assert.deepEqual(first, second);
    assert.deepEqual(first[3][8], first[6][0][1][0][2]);
    assert.equal(accepts(property(first[3][8], "label"), null), true);
    assert.equal(accepts(property(first[3][8], "label"), 3), true);
});

test("all structured-output schema entry points accept nullable unions", () => {
    const schema = { type: ["string", "null"] };
    for (const generationConfig of [
        { responseSchema: schema },
        { response_schema: schema },
        { responseJsonSchema: schema },
        { response_json_schema: schema },
        { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema } } },
    ]) {
        const wire = WireCodec.encode("gemini-4-argon", { ...body(), generationConfig });
        assert.equal(accepts(wire[3][8], null), true);
        assert.equal(accepts(wire[3][8], "ok"), true);
        assert.equal(accepts(wire[3][8], 3), false);
    }
});

test("function parameter schema variants encode nested nullable unions", () => {
    const schema = { properties: { query: { type: ["string", "null"] } }, type: "object" };
    for (const field of ["parameters", "parametersJsonSchema"]) {
        const wire = WireCodec.encode("gemini-4-argon", {
            ...body(),
            tools: [{ functionDeclarations: [{ [field]: schema, name: "lookup" }] }],
        });
        const query = property(wire[6][0][1][0][2], "query");
        assert.equal(accepts(query, null), true);
        assert.equal(accepts(query, "ok"), true);
        assert.equal(accepts(query, 3), false);
    }
});

test("malformed schemas fail locally with a non-retryable 400 and useful location", () => {
    for (const schema of [null, true, [], { type: "unsupported" }, { type: [] }, { type: ["string", null] }])
        rejectsAt(() => WireCodec.schema(schema));
    rejectsAt(() => WireCodec.schema({ properties: { query: { type: "unsupported" } }, type: "object" }), "query");
    rejectsAt(() => WireCodec.schema({ items: { anyOf: [{ type: "unsupported" }] }, type: "array" }), "items", "anyOf");
    for (const keyword of ["oneOf", "anyOf", "allOf"])
        rejectsAt(() => WireCodec.schema({ [keyword]: "invalid" }), keyword);
    rejectsAt(() => WireCodec.schema({ items: [], type: "array" }), "items");
    rejectsAt(() => WireCodec.schema({ properties: [], type: "object" }), "properties");
});

test("structured-output schema failures identify the request field and nested property", () => {
    for (const field of ["responseSchema", "responseJsonSchema"]) {
        rejectsAt(
            () =>
                WireCodec.encode("gemini-4-argon", {
                    ...body(),
                    generationConfig: {
                        [field]: { properties: { query: { type: "unsupported" } }, type: "object" },
                    },
                }),
            "generationConfig",
            field,
            "query"
        );
    }
});

test("excessive schema nesting fails with a non-retryable 400 instead of exhausting the stack", () => {
    let schema = { type: "string" };
    for (let depth = 0; depth < 80; depth++) schema = { items: schema, type: "array" };
    rejectsAt(() => WireCodec.schema(schema), "nesting", "items");
});

test("tool schema failures identify the declaration and invalid parameter", () => {
    for (const field of ["parameters", "parametersJsonSchema"]) {
        rejectsAt(
            () =>
                WireCodec.encode("gemini-4-argon", {
                    ...body(),
                    tools: [
                        {
                            functionDeclarations: [
                                { name: "valid", parameters: { type: "object" } },
                                {
                                    [field]: { properties: { query: { type: "unsupported" } }, type: "object" },
                                    name: "lookup",
                                },
                            ],
                        },
                    ],
                }),
            "tools",
            "functionDeclarations",
            "[1]",
            field,
            "query"
        );
    }
});
