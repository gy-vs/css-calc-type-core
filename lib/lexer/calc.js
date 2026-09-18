import {
    Comment,
    Comma,
    Delim,
    Dimension,
    Function as FunctionToken,
    Ident,
    LeftParenthesis,
    Number as NumberToken,
    Percentage,
    RightParenthesis,
    WhiteSpace,
    consumeNumber
} from '../tokenizer/index.js';

// The type of a math expression is one of:
// - NUMBER – a <number> (or <integer>)
// - PERCENTAGE – a <percentage>
// - a dimension group name, i.e. 'length', 'angle', 'time', 'frequency',
//   'resolution', 'flex', 'decibel' or 'semitones'
// - UNKNOWN – the expression can't be fully analyzed on this stage (e.g. it contains
//   var(), an unknown function or an unsupported construct); such expressions
//   are always considered valid
const NUMBER = 'number';
const PERCENTAGE = 'percentage';
const UNKNOWN = 'unknown';

const calcFunctionNames = new Set([
    'calc(',
    '-moz-calc(',
    '-webkit-calc('
]);

// min(), max() and clamp() share the same type checking rules:
// all arguments should have a consistent type, the result has that type
const comparisonFunctionNames = new Set([
    'min(',
    'max(',
    'clamp('
]);

// https://drafts.csswg.org/css-values-4/#calc-constants
const calcConstants = new Set([
    'e',
    'pi',
    'infinity',
    'nan'
]);

export function isCalcFunctionName(name) {
    name = name.toLowerCase();

    return calcFunctionNames.has(name) || comparisonFunctionNames.has(name);
}

// A unit group map is used to resolve a dimension token unit to a type.
// It's built from the same unit sets the lexer uses for generic types,
// so custom units provided via a lexer config are respected as well.
export function createUnitTypeMap(units) {
    const unitTypes = new Map();

    for (const [group, unitList] of Object.entries(units)) {
        if (Array.isArray(unitList)) {
            for (const unit of unitList) {
                unitTypes.set(unit.toLowerCase(), group);
            }
        }
    }

    return unitTypes;
}

// Since a matching process is synchronous and single threaded, a module level
// slot is used to pass a calc() error from a generic type matcher (which can't
// report a reason for a mismatch) to the Lexer that builds a final error.
// Only the first error is kept since it refers to the most relevant
// (the leftmost) problem in a value.
let lastCalcError = null;

export function recordCalcError(error) {
    if (lastCalcError === null) {
        lastCalcError = error;
    }
}

export function resetCalcError() {
    lastCalcError = null;
}

export function getCalcError() {
    return lastCalcError;
}

class CalcExpressionError {
    constructor(token, message) {
        this.token = token;
        this.message = message;
    }
}

function isWhiteSpaceOrComment(token) {
    return token !== null && (token.type === WhiteSpace || token.type === Comment);
}

function skipWhiteSpace(state) {
    while (isWhiteSpaceOrComment(currentToken(state))) {
        state.pos++;
    }
}

function currentToken(state) {
    return state.pos < state.tokens.length ? state.tokens[state.pos] : null;
}

// find an index of a parenthesis matching a function or "(" token at a given position
function findBalancedEnd(tokens, start) {
    let depth = 0;

    for (let i = start; i < tokens.length; i++) {
        switch (tokens[i].type) {
            case FunctionToken:
            case LeftParenthesis:
                depth++;
                break;

            case RightParenthesis:
                depth--;

                if (depth === 0) {
                    return i;
                }

                break;
        }
    }

    return -1;
}

function dimensionType(token, unitTypes) {
    const numberEnd = consumeNumber(token.value, 0);
    const unit = token.value.substr(numberEnd).toLowerCase();

    // an unknown unit (e.g. a custom one) makes the expression unanalyzable,
    // such expressions are passed through rather than reported
    return unitTypes.get(unit) || UNKNOWN;
}

// <calc-sum> = <calc-product> [ [ '+' | '-' ] <calc-product> ]#
function parseSum(state) {
    let left = parseProduct(state);

    if (left === null) {
        return null;
    }

    for (;;) {
        skipWhiteSpace(state);

        const operator = currentToken(state);

        if (operator === null || operator.type !== Delim || (operator.value !== '+' && operator.value !== '-')) {
            return left;
        }

        state.pos++;

        const right = parseProduct(state);

        if (right === null) {
            return null;
        }

        left = combineSum(left, right, operator);
    }
}

// <calc-product> = <calc-value> [ [ '*' | '/' ] <calc-value> ]#
function parseProduct(state) {
    let left = parseValue(state);

    if (left === null) {
        return null;
    }

    for (;;) {
        skipWhiteSpace(state);

        const operator = currentToken(state);

        if (operator === null || operator.type !== Delim || (operator.value !== '*' && operator.value !== '/')) {
            return left;
        }

        state.pos++;
        skipWhiteSpace(state);

        const rightToken = currentToken(state);
        const rightStart = state.pos;
        const right = parseValue(state);

        if (right === null) {
            return null;
        }

        if (operator.value === '*') {
            left = combineProduct(left, right, operator);
        } else {
            left = combineDivision(left, right, rightToken, rightStart, state.pos);
        }
    }
}

// <calc-value> = <number> | <dimension> | <percentage> | <calc-constant> |
//   '(' <calc-sum> ')' | <calc()> | <min()> | <max()> | <clamp()> | ...
function parseValue(state) {
    skipWhiteSpace(state);

    const token = currentToken(state);

    if (token === null) {
        return null;
    }

    switch (token.type) {
        case NumberToken:
            state.pos++;
            return NUMBER;

        case Percentage:
            state.pos++;
            return PERCENTAGE;

        case Dimension:
            state.pos++;
            return dimensionType(token, state.unitTypes);

        case Ident:
            // calc() constants such as pi or infinity represent a <number>
            if (calcConstants.has(token.value.toLowerCase())) {
                state.pos++;
                return NUMBER;
            }

            return null;

        case LeftParenthesis: {
            state.pos++;

            const type = parseSum(state);

            skipWhiteSpace(state);

            if (currentToken(state) === null || currentToken(state).type !== RightParenthesis) {
                return null;
            }

            state.pos++;

            return type;
        }

        case FunctionToken: {
            const end = findBalancedEnd(state.tokens, state.pos);

            if (end === -1) {
                return null;
            }

            if (isCalcFunctionName(token.value)) {
                // nested math functions are checked the same way,
                // a type error is propagated to the top
                const result = checkCalcFunction(state.tokens.slice(state.pos, end + 1), state.unitTypes);

                state.pos = end + 1;

                return result.type;
            }

            // var(), env(), attr() and any other functions can't be analyzed
            // on this stage, treat them as a value of an unknown type
            state.pos = end + 1;

            return UNKNOWN;
        }
    }

    return null;
}

// min( <calc-sum># ) / max( <calc-sum># ) / clamp( <calc-sum>{3} )
function parseComparison(state, name) {
    let result = null;
    let argCount = 0;

    for (;;) {
        skipWhiteSpace(state);

        const argToken = currentToken(state);
        const argType = parseSum(state);

        if (argType === null) {
            return null;
        }

        argCount++;

        if (result === null) {
            result = argType;
        } else {
            result = combineArguments(result, argType, argToken, name);
        }

        skipWhiteSpace(state);

        const token = currentToken(state);

        if (token === null || token.type !== Comma) {
            break;
        }

        state.pos++;
    }

    // an unexpected number of arguments is a syntax error rather than
    // a type error, leave such expressions unanalyzed
    if (name === 'clamp' && argCount !== 3) {
        return null;
    }

    return result;
}

// a percentage can be combined with any type since it resolves
// to a context specific type (checked separately, see a percentage
// context check in Lexer#matchProperty)
function combineSum(left, right, operator) {
    if (left === UNKNOWN || right === UNKNOWN) {
        return UNKNOWN;
    }

    if (left === right) {
        return left;
    }

    if (left === PERCENTAGE) {
        return right;
    }

    if (right === PERCENTAGE) {
        return left;
    }

    throw new CalcExpressionError(
        operator,
        `Incompatible types for "${operator.value}" operator: <${left}> and <${right}>`
    );
}

function combineProduct(left, right, operator) {
    if (left === UNKNOWN || right === UNKNOWN) {
        return UNKNOWN;
    }

    // at least one operand should be a <number>
    if (left === NUMBER) {
        return right;
    }

    if (right === NUMBER) {
        return left;
    }

    throw new CalcExpressionError(
        operator,
        `At least one operand for "*" operator should be a <number>, got <${left}> and <${right}>`
    );
}

function combineDivision(left, right, rightToken, rightStart, rightEnd) {
    if (left === UNKNOWN || right === UNKNOWN) {
        return UNKNOWN;
    }

    // the right operand (a divisor) should be a <number>
    if (right !== NUMBER) {
        throw new CalcExpressionError(
            rightToken,
            `Right operand for "/" operator should be a <number>, got <${right}>`
        );
    }

    // report a division by zero when a divisor is a zero literal; when a divisor
    // is an expression its value can't be determined on this stage, so such
    // expressions are passed through (browsers resolve them to an infinity
    // which clamps to a range at computed-value time)
    if (rightEnd === rightStart + 1 && rightToken.type === NumberToken && Number(rightToken.value) === 0) {
        throw new CalcExpressionError(
            rightToken,
            'Division by zero'
        );
    }

    return left;
}

function combineArguments(left, right, argToken, name) {
    if (left === UNKNOWN || right === UNKNOWN) {
        return UNKNOWN;
    }

    if (left === right) {
        return left;
    }

    if (left === PERCENTAGE) {
        return right;
    }

    if (right === PERCENTAGE) {
        return left;
    }

    throw new CalcExpressionError(
        argToken,
        `Arguments of ${name}() should have the same type, got <${left}> and <${right}>`
    );
}

// check an expression of a single calc()/min()/max()/clamp() function,
// tokens should start with a function token and end with its closing parenthesis
function checkCalcFunction(tokens, unitTypes) {
    const name = tokens[0].value.slice(0, -1);
    const state = {
        tokens,
        pos: 1,
        unitTypes
    };

    const type = comparisonFunctionNames.has(tokens[0].value.toLowerCase())
        ? parseComparison(state, name)
        : parseSum(state);

    skipWhiteSpace(state);

    // an expression is unanalyzable when it can't be parsed or
    // some tokens are left unconsumed, pass it through
    if (type === null || state.pos !== tokens.length - 1) {
        return { type: UNKNOWN };
    }

    return { type };
}

function isTypeCompatible(type, expectedType) {
    if (type === UNKNOWN) {
        return true;
    }

    if (expectedType === 'dimension') {
        return type !== NUMBER && type !== PERCENTAGE;
    }

    // an <integer> accepts any expression resolved to a <number>,
    // a value range check is out of scope
    if (expectedType === 'integer') {
        return type === NUMBER;
    }

    return type === expectedType;
}

// Check a calc()/min()/max()/clamp() expression to be valid per css-values-4
// type checking rules and to resolve to a type compatible with expectedType
// (a generic type the expression is matched against, e.g. "length" or "number").
// Returns { type } for a valid expression or { error } with an error
// pointing to a token of a sub-expression caused a problem.
export function checkCalcExpression(tokens, expectedType, unitTypes) {
    try {
        const result = checkCalcFunction(tokens, unitTypes);

        if (!isTypeCompatible(result.type, expectedType)) {
            const name = tokens[0].value.replace(/\($/, '');

            return {
                error: new CalcExpressionError(
                    tokens[0],
                    `${name}() evaluates to <${result.type}> which doesn't match the expected type <${expectedType}>`
                )
            };
        }

        return result;
    } catch (error) {
        if (error instanceof CalcExpressionError) {
            return { error };
        }

        throw error;
    }
}

// Find ranges of the top level (not nested into each other) calc()/min()/max()/clamp()
// functions containing a <percentage-token>. Used to check that a percentage
// is allowed in a context where such an expression is used.
export function findPercentageCalcRanges(tokens) {
    const ranges = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token.type !== FunctionToken || !isCalcFunctionName(token.value)) {
            continue;
        }

        const end = findBalancedEnd(tokens, i);

        if (end === -1) {
            continue;
        }

        let hasPercentage = false;

        for (let j = i + 1; j < end; j++) {
            if (tokens[j].type === Percentage) {
                hasPercentage = true;
                break;
            }
        }

        if (hasPercentage) {
            ranges.push({ start: i, end });
        }

        // nested math functions are covered by the top level range
        i = end;
    }

    return ranges;
}
