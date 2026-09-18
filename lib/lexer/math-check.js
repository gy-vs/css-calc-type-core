import {
    Number as NumberToken,
    Percentage,
    Dimension,
    Function as FunctionToken,
    Delim,
    Comma,
    LeftParenthesis,
    RightParenthesis,
    WhiteSpace,
    Comment
} from '../tokenizer/index.js';
import { walk as walkSyntax } from '../definition-syntax/walk.js';

// Type checking for CSS math expressions (calc(), min(), max(), clamp())
// https://drafts.csswg.org/css-values-4/#calc-type-checking
//
// The generic matchers for <length>, <angle>, ... (see generic.js) accept any
// balanced math function without looking at its contents - that's the "shell"
// that let values like calc(100% - 16) pass for width. This module is a
// post-pass over a successful match tree and performs the type checking the
// shell matchers skip:
//
//   * operands of + and - must have matching types;
//   * at least one operand of * must be a <number>;
//   * the right operand of / must be a <number>, division by literal 0 errors;
//   * arguments of min()/max()/clamp() must have matching types;
//   * the inferred result type must fit the production (<length>, ...) the
//     math function was matched against.
//
// Percentages are resolved against the property context: a percentage can be
// combined with a dimension only when the syntax leading to the matched
// production accepts percentages in the same position (width is
// <length-percentage>, border-top-width is <length> only).

const CALC_FUNCTION_NAMES = new Set([
    'calc(',
    '-moz-calc(',
    '-webkit-calc('
]);
const COMPARISON_FUNCTION_NAMES = new Set([
    'min(',
    'max(',
    'clamp('
]);
const MATH_FUNCTION_NAMES = new Set([
    ...CALC_FUNCTION_NAMES,
    ...COMPARISON_FUNCTION_NAMES
]);

// Generic productions whose math "shell" may consume a math function, mapped
// to the kind of value they stand for.
const GENERIC_PRODUCTION_KINDS = {
    'length': 'dimension',
    'angle': 'dimension',
    'time': 'dimension',
    'frequency': 'dimension',
    'resolution': 'dimension',
    'flex': 'dimension',
    'decibel': 'dimension',
    'semitones': 'dimension',
    'dimension': 'dimension',
    'percentage': 'percentage',
    'number': 'number',
    'integer': 'number'
};

const DIMENSION_CATEGORIES = [
    'length',
    'angle',
    'time',
    'frequency',
    'resolution',
    'flex',
    'decibel',
    'semitones'
];

const NUMBER = { kind: 'number' };
const PERCENTAGE = { kind: 'percentage' };

function isFunctionToken(token, names) {
    return token !== null && token.type === FunctionToken && names.has(token.value.toLowerCase());
}

function isInsignificant(token) {
    return token.type === WhiteSpace || token.type === Comment;
}

// unit name -> dimension category, based on the lexer units (extendable via
// a lexer config)
function buildUnitToCategoryMap(units) {
    const map = Object.create(null);

    for (const category of DIMENSION_CATEGORIES) {
        const list = units[category];

        if (Array.isArray(list)) {
            for (const unit of list) {
                map[unit.toLowerCase()] = category;
            }
        }
    }

    return map;
}

// Names referenced by a syntax definition (transitively flattened). A name
// without a definition stays a leaf; generic types are functions and resolve
// to leaves as well. The result is cached per (lexer, syntax), since forked
// lexers reuse the same syntax AST nodes with different type sets.
function getSyntaxClosure(lexer, syntax) {
    if (!syntax || typeof syntax !== 'object') {
        return null;
    }

    let perLexer = closureCache.get(lexer);

    if (perLexer === undefined) {
        perLexer = new WeakMap();
        closureCache.set(lexer, perLexer);
    }

    let closure = perLexer.get(syntax);

    if (closure === undefined) {
        closure = buildClosure(lexer, syntax);
        perLexer.set(syntax, closure);
    }

    return closure;
}

const closureCache = new WeakMap();
const hasOwnProperty = Object.prototype.hasOwnProperty;

function buildClosure(lexer, syntax) {
    const result = new Set();
    const stack = [];
    const visited = new Set();

    try {
        walkSyntax(syntax, node => {
            if (node.type === 'Type' || node.type === 'Property') {
                stack.push(node.name);
            }
        });
    } catch (e) {
        return null;
    }

    for (let name; name = stack.shift();) {
        const key = name.toLowerCase();

        if (visited.has(key)) {
            continue;
        }

        visited.add(key);

        const descriptor =
            (hasOwnProperty.call(lexer.types, key) && lexer.types[key]) ||
            (hasOwnProperty.call(lexer.properties, key) && lexer.properties[key]) ||
            null;

        if (!descriptor) {
            result.add(key);
            continue;
        }

        let referenced = null;

        try {
            referenced = [];
            walkSyntax(descriptor.syntax, node => {
                if (node.type === 'Type' || node.type === 'Property') {
                    referenced.push(node.name);
                }
            });
        } catch (e) {
            referenced = null;
        }

        if (referenced === null) {
            result.add(key);
        } else {
            for (const ref of referenced) {
                stack.push(ref);
            }
        }
    }

    return result;
}

// Policy for a single math function match site.
//
// Two questions are answered at different granularity, because the matcher
// commits a math function to the FIRST math-accepting shell of a multi-branch
// syntax (so a <percentage> shell may host an expression that is really a
// <length> for a property declared as `<percentage> | <length>`):
//
//   1. May the operands/arguments be combined here? That is answered from the
//      syntax definitions that lead to the committed shell (intermediate
//      hosts), never from the property root: the root may accept a dimension
//      in one alternative and a percentage in another (line-height:
//      <number> | <length> | <percentage>), where they can't be added. When
//      an intermediate definition accepts both (width reaches the shell via
//      <length-percentage>) they can.
//
//   2. Is the inferred result acceptable for the property at all? That is
//      answered against the property/descriptor root syntax (any branch may
//      accept the result type), so calc(50%) committed to a <length> shell
//      passes for a `<percentage> | <length>` property. With no single value
//      context (at-rule preludes, anonymous type matches) the result is not
//      compared - only the in-expression rules are enforced there.
function createPolicy(lexer, genericName, hostChain, rootSyntax) {
    const expectedKind = GENERIC_PRODUCTION_KINDS[genericName];

    if (rootSyntax === null) {
        return {
            strict: false,
            genericName,
            expectedKind,
            percentageMixable: () => true,
            percentageNumberMixable: true,
            resultAccepted: () => true
        };
    }

    const rootClosure = getSyntaxClosure(lexer, rootSyntax);

    // granular, per-host mixing permissions. The innermost host is the
    // generic production that consumed the math shell; each outer host is a
    // Type/Property reference whose own definition may establish that a
    // percentage and the dimension/number share a value space.
    const mixableCategories = new Set();
    let percentageNumberMixable = false;

    for (let h = hostChain.length - 2; h >= 0; h--) {
        const node = hostChain[h] && hostChain[h].syntax;

        if (!node || (node.type !== 'Type' && node.type !== 'Property')) {
            continue;
        }

        const descriptor = lexer.types[node.name] || lexer.properties[node.name];

        if (!descriptor || !descriptor.syntax) {
            continue;
        }

        const closure = getSyntaxClosure(lexer, descriptor.syntax);

        if (closure === null || !closure.has('percentage')) {
            continue;
        }

        // dimension + percentage: unlike number/percentage (where the same
        // syntax can mean a shared value space or separate alternatives, e.g.
        // zoom vs opacity), a percentage referenced by a length/angle/time/...
        // definition represents that dimension per the CSS Values spec - the
        // <length-percentage> type is itself defined as `<length> |
        // <percentage>`. So a dimension mixes with a percentage whenever the
        // enclosing definition accepts both, regardless of the combinator.
        if (expectedKind === 'dimension') {
            for (const category of DIMENSION_CATEGORIES) {
                if (closure.has(category)) {
                    mixableCategories.add(category);
                }
            }
        }

        // number + percentage share a value space only when a single syntax
        // group accepts both without alternatives: zoom is `<number> ||
        // <percentage>`, while opacity-value is `<number> | <percentage>` and
        // keeps the two as separate spaces
        if (expectedKind === 'number' &&
            (closure.has('number') || closure.has('integer')) &&
            percentageCooccursWith(descriptor.syntax, new Set(['number', 'integer']))) {
            percentageNumberMixable = true;
        }
    }

    return {
        strict: true,
        genericName,
        expectedKind,
        percentageMixable(category) {
            return mixableCategories.has(category);
        },
        percentageNumberMixable,
        resultAccepted(type) {
            if (rootClosure === null) {
                return true;
            }

            if (type === NUMBER) {
                return rootClosure.has('number') || rootClosure.has('integer');
            }

            if (type === PERCENTAGE) {
                return rootClosure.has('percentage');
            }

            if (type.kind === 'dimension') {
                return rootClosure.has(type.category) || rootClosure.has('dimension');
            }

            return true;
        }
    };
}

// Whether a syntax definition has a single group (juxtaposition or the `||`
// "one or more in any order" combinator, but not the `|` alternative
// combinator) that references both a percentage and one of the given type
// names. Used to tell zoom (`<number> || <percentage>`, where the percentage
// normalises to a number) apart from opacity (`<number> | <percentage>`,
// separate value spaces). Dimension mixing doesn't need this distinction,
// see createPolicy().
function percentageCooccursWith(syntax, typeNames) {
    let result = false;

    const visitGroup = (group) => {
        if (result) {
            return;
        }

        // alternatives split value spaces; descend into each term but don't
        // combine findings across a '|' group
        if (group.combinator === '|') {
            for (const term of group.terms) {
                if (term.type === 'Group') {
                    visitGroup(term);
                }
            }

            return;
        }

        let hasOther = false;
        let hasPercentage = false;

        const inspect = (node) => {
            switch (node.type) {
                case 'Group':
                    if (node.combinator === '|') {
                        visitGroup(node);
                    } else {
                        node.terms.forEach(inspect);
                    }

                    break;

                case 'Multiplier':
                    inspect(node.term);
                    break;

                case 'Type':
                    if (typeNames.has(node.name)) {
                        hasOther = true;
                    } else if (node.name === 'percentage') {
                        hasPercentage = true;
                    }

                    break;
            }
        };

        group.terms.forEach(inspect);

        if (hasOther && hasPercentage) {
            result = true;
        }
    };

    if (syntax.type === 'Group') {
        visitGroup(syntax);
    }

    return result;
}

function typeName(type) {
    if (type === null) {
        return 'unknown';
    }

    if (type === NUMBER) {
        return 'number';
    }

    if (type === PERCENTAGE) {
        return 'percentage';
    }

    return type.category;
}

function literalType(token, unitToCategory) {
    switch (token.type) {
        case NumberToken:
            return NUMBER;

        case Percentage:
            return PERCENTAGE;

        case Dimension: {
            // split a number and a unit ("-16px" -> "px")
            const value = token.value;
            let i = 0;

            if (value.charCodeAt(0) === 0x2B /* + */ || value.charCodeAt(0) === 0x2D /* - */) {
                i++;
            }

            while (i < value.length) {
                const code = value.charCodeAt(i);

                if ((code >= 0x61 && code <= 0x7A) || (code >= 0x41 && code <= 0x5A)) {
                    break;
                }

                i++;
            }

            const unit = value.substr(i).toLowerCase();
            const category = hasOwnProperty.call(unitToCategory, unit)
                ? unitToCategory[unit]
                : null;

            // An unknown unit might come from an extended lexer config; treat
            // it as untyped instead of producing a false positive.
            return category === null ? null : { kind: 'dimension', category };
        }

        default:
            return null;
    }
}

// Add/sub type rules. Returns { type } or { error: true }. An operand with an
// unknown type makes the result unknown but is never an error.
function combineAddSub(left, right, policy) {
    if (left === null || right === null) {
        return { type: null };
    }

    if (left.kind === 'number' && right.kind === 'number') {
        return { type: NUMBER };
    }

    if (left === PERCENTAGE && right === PERCENTAGE) {
        return { type: PERCENTAGE };
    }

    if (left.kind === 'dimension' && right.kind === 'dimension') {
        if (left.category !== right.category) {
            return { error: true };
        }

        return { type: left };
    }

    // dimension/number <-> percentage is allowed only when the percentage
    // represents the same kind of value at the match site; the result keeps
    // the dimension/number kind
    let dimension = null;
    let numericKind = null;

    if (left.kind === 'dimension' && right === PERCENTAGE) {
        dimension = left;
    } else if (left === PERCENTAGE && right.kind === 'dimension') {
        dimension = right;
    } else if (left.kind === 'number' && right === PERCENTAGE) {
        numericKind = 'number-left';
    } else if (left === PERCENTAGE && right.kind === 'number') {
        numericKind = 'number-right';
    }

    if (dimension !== null && policy.percentageMixable(dimension.category)) {
        return { type: dimension };
    }

    // e.g. zoom accepts `<number> || <percentage>`, so calc(1 + 50%) is valid;
    // the result behaves as a number
    if (numericKind !== null && policy.percentageNumberMixable) {
        return { type: NUMBER };
    }

    return { error: true };
}

// Recursive-descent checker over a token slice of one math function body.
// Parse failures of grammar shape return { bail: true } and are not reported:
// such values are left to syntax matching, and reporting them here could turn
// a previously-passing declaration into an error.
//
// Along with the type, every parsed node carries `numValue`: a finite number
// when the node is a numeric-only expression with a value known at this stage
// (e.g. 2, 1 * 0, (4 - 2) / 2), or null when it contains a dimension, a
// percentage, or any construct whose value can't be resolved (var(), ...).
// It powers two rules: a numeric zero is the "universal zero" that matches
// any type, and a provably zero divisor is an error.
function createChecker(tokens, unitToCategory, policy) {
    let i = 0;

    function peek() {
        return i < tokens.length ? tokens[i] : null;
    }

    function next() {
        return i < tokens.length ? tokens[i++] : null;
    }

    function skipInsignificant() {
        while (i < tokens.length && isInsignificant(tokens[i])) {
            i++;
        }
    }

    function failure(node, message) {
        return {
            error: {
                message,
                start: node.start,
                end: node.end
            }
        };
    }

    function literalNode(token, start) {
        return {
            type: literalType(token, unitToCategory),
            numValue: token.type === NumberToken ? Number(token.value) : null,
            token,
            start,
            end: i
        };
    }

    // value := <number> | <percentage> | <dimension>
    //        | math-function | '(' sum ')' | other-function
    function parseValue() {
        skipInsignificant();

        const start = i;
        const token = peek();

        if (token === null) {
            return { bail: true };
        }

        if (isFunctionToken(token, MATH_FUNCTION_NAMES)) {
            return parseMathFunction();
        }

        if (token.type === LeftParenthesis) {
            next();

            const inner = parseSum();

            if (inner.bail || inner.error) {
                return inner;
            }

            skipInsignificant();

            const close = peek();

            if (!close || close.type !== RightParenthesis) {
                return { bail: true };
            }

            next();

            return {
                type: inner.type,
                numValue: inner.numValue,
                token: inner.token,
                start,
                end: i
            };
        }

        if (token.type === NumberToken || token.type === Percentage || token.type === Dimension) {
            next();

            return literalNode(token, start);
        }

        // var(), env(), attr(), constants and other functions: the type and
        // the value can't be determined at validation time, consume the
        // balanced construct
        if (token.type === FunctionToken) {
            return consumeBalanced();
        }

        return { bail: true };
    }

    function consumeBalanced() {
        const start = i;
        let depth = 0;

        do {
            const token = next();

            if (token === null) {
                return { bail: true };
            }

            if (token.type === FunctionToken || token.type === LeftParenthesis) {
                depth++;
            } else if (token.type === RightParenthesis) {
                depth--;
            }
        } while (depth > 0);

        return {
            type: null,
            numValue: null,
            token: null,
            start,
            end: i
        };
    }

    // product := value (('*' | '/') value)*
    function parseProduct() {
        const left = parseValue();

        if (left.bail || left.error) {
            return left;
        }

        for (;;) {
            const saved = i;

            skipInsignificant();

            const operator = peek();

            if (!operator || operator.type !== Delim || (operator.value !== '*' && operator.value !== '/')) {
                i = saved;
                break;
            }

            next();

            const right = parseValue();

            if (right.bail || right.error) {
                return right;
            }

            if (operator.value === '*') {
                if (left.type !== null && right.type !== null) {
                    if (left.type.kind !== 'number' && right.type.kind !== 'number') {
                        return failure(right,
                            'Multiplication requires at least one operand to be a number, ' +
                            'but got `' + typeName(left.type) + '` and `' + typeName(right.type) + '`');
                    }

                    left.type = left.type.kind === 'number' ? right.type : left.type;
                } else {
                    // one operand is unknown - the result type is unknown too;
                    // multiplication stays legal regardless of the hidden type
                    left.type = null;
                }

                left.numValue = left.numValue !== null && right.numValue !== null
                    ? left.numValue * right.numValue
                    : null;
            } else {
                if (right.type !== null && right.type.kind !== 'number') {
                    return failure(right,
                        'Division requires the divisor to be a number, ' +
                        'but got `' + typeName(right.type) + '`');
                }

                // A divisor with a provably zero value (0, 2 * 0, (1 - 1),
                // calc( ... ) known to be 0, ...) is always an error.
                // When the divisor can't be evaluated here (var(), an
                // expression containing an unknown operand, ...) the value is
                // passed on purpose: we can't prove it's zero, and rejecting
                // expressions with unresolvable operands would produce false
                // positives - custom property references are unknown by
                // design and must not break the build.
                if (right.numValue === 0) {
                    return failure(right, 'Division by zero is not allowed');
                }

                // number / number -> number; dimension / number -> dimension;
                // if the divisor is unknown only a numeric dividend becomes
                // untyped, a dimension / unknown is still a dimension
                if (right.type === null) {
                    left.type = left.type === NUMBER ? null : left.type;
                }

                left.numValue = left.numValue !== null && right.numValue !== null
                    ? left.numValue / right.numValue
                    : null;
            }

            left.token = null;
            left.end = right.end;
        }

        return left;
    }

    // A numeric zero (0px is NOT one - only a unitless, known zero) plays the
    // role of the additive identity and can be combined with any type.
    function isUniversalZero(node) {
        return node.numValue === 0 && node.type === NUMBER;
    }

    // sum := product (('+' | '-') product)*
    function parseSum() {
        const left = parseProduct();

        if (left.bail || left.error) {
            return left;
        }

        for (;;) {
            skipInsignificant();

            const operator = peek();

            if (!operator || operator.type !== Delim || (operator.value !== '+' && operator.value !== '-')) {
                break;
            }

            next();

            const right = parseProduct();

            if (right.bail || right.error) {
                return right;
            }

            // a universal zero operand takes the other side's type
            if (isUniversalZero(right)) {
                left.numValue = left.numValue !== null && right.numValue !== null
                    ? applyAddSub(left.numValue, right.numValue, operator.value)
                    : left.numValue;
                left.end = right.end;
                continue;
            }

            if (isUniversalZero(left)) {
                left.numValue = left.numValue !== null && right.numValue !== null
                    ? applyAddSub(left.numValue, right.numValue, operator.value)
                    : right.numValue;
                left.type = right.type;
                left.end = right.end;
                continue;
            }

            const combined = combineAddSub(left.type, right.type, policy);

            if (combined.error) {
                return failure(right,
                    'Incompatible operands for `' + operator.value + '`: ' +
                    '`' + typeName(left.type) + '` and `' + typeName(right.type) + '` can\'t be combined');
            }

            left.type = combined.type;
            left.numValue = left.numValue !== null && right.numValue !== null
                ? applyAddSub(left.numValue, right.numValue, operator.value)
                : null;
            left.token = null;
            left.end = right.end;
        }

        return left;
    }

    function applyAddSub(a, b, op) {
        return op === '+' ? a + b : a - b;
    }

    // arguments := sum (',' sum)*
    function parseArguments() {
        const args = [];

        for (;;) {
            const arg = parseSum();

            if (arg.bail || arg.error) {
                return arg;
            }

            args.push(arg);

            skipInsignificant();

            if (peek() && peek().type === Comma) {
                next();
                continue;
            }

            break;
        }

        return { args };
    }

    function parseMathFunction() {
        const start = i;
        const fnToken = next();
        const name = fnToken.value.toLowerCase();

        skipInsignificant();

        // an empty argument list is an explicit, unambiguous error
        if (peek() && peek().type === RightParenthesis) {
            next();

            return failure(
                { start, end: i },
                '`' + name.slice(0, -1) + '()` requires at least 1 argument'
            );
        }

        const parsed = parseArguments();

        if (parsed.bail || parsed.error) {
            return parsed;
        }

        skipInsignificant();

        if (!peek() || peek().type !== RightParenthesis) {
            return { bail: true };
        }

        next();

        const args = parsed.args;

        if (CALC_FUNCTION_NAMES.has(name)) {
            // calc() requires exactly one argument
            if (args.length !== 1) {
                return { bail: true };
            }

            const only = args[0];

            return {
                type: only.type,
                numValue: only.numValue,
                token: only.token,
                start,
                end: i
            };
        }

        // min()/max(): one or more arguments; clamp(): exactly three
        if (name === 'clamp(' && args.length !== 3) {
            return failure(
                { start, end: i },
                '`clamp()` requires exactly 3 arguments, but got ' + args.length
            );
        }

        if (args.length < 1) {
            return failure(
                { start, end: i },
                '`' + name.slice(0, -1) + '()` requires at least 1 argument'
            );
        }

        const first = args[0];

        for (let k = 1; k < args.length; k++) {
            const current = args[k];

            // a universal zero argument matches any argument type
            // (min(0, 1px) is valid), so compare the non-zero types only
            const firstType = isUniversalZero(first) ? current.type : first.type;
            const currentType = isUniversalZero(current) ? first.type : current.type;
            const combined = combineAddSub(firstType, currentType, policy);

            if (combined.error) {
                return failure(current,
                    'Arguments of `' + name.slice(0, -1) + '()` must have the same type, ' +
                    'but got `' + typeName(first.type) + '` and `' + typeName(current.type) + '`');
            }
        }

        // the result type is that of the first non-zero, non-unknown
        // argument - a universal zero argument adapts to the others
        let resultType = null;
        let resultToken = null;

        for (const arg of args) {
            if (arg.type !== null && !isUniversalZero(arg)) {
                resultType = arg.type;
                resultToken = arg.token;
                break;
            }
        }

        if (resultType === null) {
            resultType = first.type;
            resultToken = first.token;
        }

        // The numeric value of a comparison function is rarely safe to
        // know exactly:
        //   * all arguments known to be zero           -> it evaluates to 0;
        //   * any argument unknown (var(), ...)        -> value unknowable;
        //   * every argument known and some non-zero   -> the result is
        //                                                 known non-zero, but
        //                                                 its exact value is
        //                                                 not derivable here.
        // A NaN sentinel represents the last case - it keeps division-by-zero
        // detection quiet (NaN !== 0) while still carrying "numeric result".
        let resultNumValue = 0;

        for (const arg of args) {
            if (arg.numValue === null) {
                resultNumValue = null;
                break;
            }

            if (arg.numValue !== 0) {
                resultNumValue = NaN;
            }
        }

        return {
            type: resultType,
            numValue: resultNumValue,
            token: resultToken,
            start,
            end: i
        };
    }

    return {
        check() {
            const result = parseMathFunction();

            if (result.bail || result.error) {
                return result.error || null;
            }

            skipInsignificant();

            if (i !== tokens.length) {
                return null;
            }

            if (!resultTypeMatchesExpected(result, policy)) {
                return {
                    message: 'A math expression of type `' + typeName(result.type) +
                        '` can\'t be used where `' + policy.genericName + '` is expected',
                    start: 0,
                    end: tokens.length
                };
            }

            return null;
        }
    };
}

function resultTypeMatchesExpected(result, policy) {
    const type = result.type;

    if (type === null) {
        return true;
    }

    // In a context without a single value definition (a bare type match, an
    // at-rule prelude such as a media feature) the matcher may have committed
    // any math-accepting shell from a multi-type union. There is no property
    // syntax to compare the result against, so only the in-expression rules
    // are enforced there.
    if (!policy.strict) {
        return true;
    }

    // a known unitless zero (calc(0), min(0, 0), ...) matches any production
    if (result.numValue === 0 && type === NUMBER) {
        return true;
    }

    // the result is acceptable when any branch of the value definition's
    // syntax accepts its type - the matcher commits the first math shell of a
    // multi-branch syntax, which need not be the branch the expression's type
    // belongs to
    return policy.resultAccepted(type);
}

// Walk a successful match tree, mapping each leaf token to its index in the
// prepared token list and recording its enclosing syntax (host) chain.
function annotateLeaves(tree, tokens, state, hostChain, leaves) {
    const chain = tree.syntax ? hostChain.concat(tree) : hostChain;

    for (const item of tree.match) {
        if (item.match) {
            annotateLeaves(item, tokens, state, chain, leaves);
            continue;
        }

        while (state.index < tokens.length && isInsignificant(tokens[state.index])) {
            state.index++;
        }

        leaves[state.index++] = chain;
    }
}

// Entry point. Returns null when all math expressions are fine, otherwise an
// error descriptor with tokens marking the offending sub-expression. `ref`
// carries the value definition the matching started with ({ type, syntax }) or
// is null for contexts without a single value definition (at-rule preludes,
// anonymous type matches).
export default function checkMathExpressions(lexer, tokens, matchTree, ref) {
    const leaves = [];

    annotateLeaves(matchTree, tokens, { index: 0 }, [], leaves);

    const unitToCategory = buildUnitToCategoryMap(lexer.units);
    const strict = ref !== null;
    const rootSyntax = strict ? ref.syntax : null;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (!isFunctionToken(token, MATH_FUNCTION_NAMES)) {
            continue;
        }

        const hostChain = leaves[index];

        if (!hostChain) {
            continue;
        }

        // the innermost Type host names the generic production that consumed
        // the function shell
        let genericName = null;

        for (let k = hostChain.length - 1; k >= 0; k--) {
            const node = hostChain[k].syntax;

            if (node && node.type === 'Type') {
                genericName = node.name;
                break;
            }
        }

        if (genericName === null || !hasOwnProperty.call(GENERIC_PRODUCTION_KINDS, genericName)) {
            continue;
        }

        // bound the token slice by the matching closing parenthesis
        let end = index + 1;
        let depth = 1;

        while (end < tokens.length && depth > 0) {
            const t = tokens[end];

            if (t.type === FunctionToken || t.type === LeftParenthesis) {
                depth++;
            } else if (t.type === RightParenthesis) {
                depth--;
            }

            end++;
        }

        const slice = tokens.slice(index, end);
        const policy = createPolicy(lexer, genericName, hostChain, strict ? rootSyntax : null);
        const error = createChecker(slice, unitToCategory, policy).check();

        if (error !== null) {
            const startOffset = Math.max(0, Math.min(error.start, slice.length - 1));
            const endOffset = Math.max(startOffset + 1, Math.min(error.end, slice.length));

            return {
                message: error.message,
                startToken: slice[startOffset],
                endToken: slice[endOffset - 1]
            };
        }

        // nested math functions are reached via recursion within the checker,
        // so skip the whole balanced body here
        index = end - 1;
    }

    return null;
}
