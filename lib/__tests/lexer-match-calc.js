import assert from 'assert';
import { parse, lexer, fork } from 'css-tree';

const valid = [
    // basic math
    ['width', 'calc(1px)'],
    ['width', 'calc(1px + 2px)'],
    ['width', 'calc(2px - 1px)'],
    ['width', 'calc(2 * 1px)'],
    ['width', 'calc(1px * 2)'],
    ['width', 'calc(1px / 2)'],
    ['width', 'calc(100% / 3)'],
    ['width', 'calc((100% - 16px) / 2)'],
    ['width', 'calc(-5px)'],
    ['width', 'calc(1px - -2px)'],
    ['width', 'calc(((1px + 2px)))'],
    ['width', 'calc(1em + 1rem)'],
    ['width', 'calc(1px + 1vh)'],
    ['width', 'calc(pi * 1px)'],
    ['width', 'calc( 1px + 1% )'],
    ['width', 'calc(1px + 2px /* comment */)'],
    ['transition-duration', 'calc(1s + 2ms)'],
    ['transition-duration', 'calc(2 * 100ms)'],
    ['rotate', 'calc(1deg + 2rad)'],
    ['grid-template-columns', 'calc(1fr + 2fr)'],
    ['grid-template-columns', 'minmax(100px, calc(1fr + 2fr))'],

    // a percentage can be combined with a dimension it resolves to
    ['width', 'calc(1px + 1%)'],
    ['width', 'calc(100% - 16px)'],
    ['width', 'calc(1% + 2%)'],
    ['width', 'calc(50% * 2)'],
    ['width', 'calc(2 * 50%)'],
    ['margin', 'calc(1px + 1%) calc(2px - 1%)'],
    ['font-size', 'calc(1px + 1%)'],
    ['line-height', 'calc(1% + 1px)'],
    ['opacity', 'calc(50% - 0.1)'],
    ['opacity', 'calc(50%)'],
    ['background-position', 'calc(1px + 1%)'],

    // min()/max()/clamp()
    ['width', 'min(1px, 2px)'],
    ['width', 'min(1px, 2%)'],
    ['width', 'min(1px)'],
    ['width', 'max(1px, 2px)'],
    ['width', 'clamp(1px, 2%, 3px)'],
    ['opacity', 'min(0.5, 50%)'],
    ['line-height', 'min(1px, 2px)'],

    // nested math functions, a type should be inferred through the nesting
    ['width', 'calc(min(1px, 2%) + max(3px, 4%))'],
    ['width', 'min(calc(1px + 1%), max(2px, 3em))'],
    ['width', 'calc(1px + (2px / 3) + 10%)'],
    ['width', 'calc(min(1px, 2px) + max(3px, 4px))'],

    // a number is ok where a number or an integer is expected
    ['z-index', 'calc(1 + 2)'],
    ['flex-grow', 'calc(1 + 2)'],
    ['line-height', 'calc(1 + 1)'],
    ['opacity', 'calc(0.5)'],
    ['tab-size', 'calc(2 * 2)'],

    // vendor prefixed and case insensitive function names
    ['width', 'CALC(1px + 1%)'],
    ['width', '-webkit-calc(1px + 1%)'],
    ['width', '-moz-calc(1px + 1%)'],
    ['width', 'MIN(1px, 2%)'],

    // expressions that can't be analyzed on this stage are passed through
    ['width', 'calc(1px + round(1px, 2px))'], // round() is not analyzed
    ['width', 'round(1px, 2px)'],
    ['width', 'calc(1px + unknown-fn(1s))'], // an unknown function
    ['width', 'calc(1foo + 1px)'], // an unknown unit
    ['width', 'calc(1px / (1 - 1))'], // a divisor is not a literal, its value can't be determined
    ['width', 'clamp(1px, 2px)'], // a wrong argument count is a syntax error, not a type error
    ['width', 'calc(1px +)'], // a broken expression is a syntax error, not a type error
    ['width', 'calc()']
];

// [property, value, expected error message, expected mismatch offset]
const invalid = [
    // an expression type doesn't match the expected type
    ['width', 'calc(1 + 1)', 'calc() evaluates to <number> which doesn\'t match the expected type <length>', 0],
    ['width', 'calc(100% - 16)', 'calc() evaluates to <number> which doesn\'t match the expected type <length>', 0],
    ['margin', 'calc(100% - 16)', 'calc() evaluates to <number> which doesn\'t match the expected type <length>', 0],
    ['width', 'calc(50% + 1)', 'calc() evaluates to <number> which doesn\'t match the expected type <length>', 0],
    ['opacity', 'calc(1px)', 'calc() evaluates to <length> which doesn\'t match the expected type <number>', 0],
    ['opacity', 'calc(50% - 1px)', 'calc() evaluates to <length> which doesn\'t match the expected type <number>', 0],
    ['z-index', 'calc(1px)', 'calc() evaluates to <length> which doesn\'t match the expected type <integer>', 0],
    ['transition-duration', 'calc(1s + 1px)', 'Incompatible types for "+" operator: <time> and <length>', 8],

    // addition/subtraction requires compatible types
    ['width', 'calc(1px + 1s)', 'Incompatible types for "+" operator: <length> and <time>', 9],
    ['width', 'calc(1px + 1deg)', 'Incompatible types for "+" operator: <length> and <angle>', 9],
    ['width', 'calc(1s - 1px)', 'Incompatible types for "-" operator: <time> and <length>', 8],
    ['width', 'calc(1fr + 1px)', 'Incompatible types for "+" operator: <flex> and <length>', 9],

    // multiplication requires at least one operand to be a number
    ['width', 'calc(1px * 1px)', 'At least one operand for "*" operator should be a <number>, got <length> and <length>', 9],
    ['width', 'calc(50% * 50%)', 'At least one operand for "*" operator should be a <number>, got <percentage> and <percentage>', 9],

    // division requires a number divisor
    ['width', 'calc(1px / 1px)', 'Right operand for "/" operator should be a <number>, got <length>', 11],
    ['width', 'calc(1px / 50%)', 'Right operand for "/" operator should be a <number>, got <percentage>', 11],
    ['width', 'calc((100% - 16px) / 2px)', 'Right operand for "/" operator should be a <number>, got <length>', 21],

    // division by zero (a literal zero divisor)
    ['width', 'calc(1px / 0)', 'Division by zero', 11],
    ['width', 'calc(1px / 0.0)', 'Division by zero', 11],
    ['width', 'calc(1px / -0)', 'Division by zero', 11],

    // min()/max()/clamp() arguments should have a consistent type
    ['width', 'min(1px, 1s)', 'Arguments of min() should have the same type, got <length> and <time>', 9],
    ['width', 'max(1px, 1deg)', 'Arguments of max() should have the same type, got <length> and <angle>', 9],
    ['width', 'clamp(1px, 1s, 1px)', 'Arguments of clamp() should have the same type, got <length> and <time>', 11],

    // errors in nested expressions are reported and point to a problem sub-expression
    ['width', 'calc(1px + min(1s, 2s))', 'Incompatible types for "+" operator: <length> and <time>', 9],
    ['width', 'calc(min(1px, 1s) + 1px)', 'Arguments of min() should have the same type, got <length> and <time>', 14],
    ['width', 'min(1px, calc(1s + 1ms))', 'Arguments of min() should have the same type, got <length> and <time>', 9],
    ['width', 'calc(1px + calc(2s + 3s))', 'Incompatible types for "+" operator: <length> and <time>', 9],
    ['margin', 'calc(1px + 1%) calc(2px + 2s)', 'Incompatible types for "+" operator: <length> and <time>', 24],

    // a percentage is not allowed in a context that doesn't accept percentages
    ['border-width', 'calc(100% - 16px)', 'Percentage is not allowed in this context', 0],
    ['border-width', 'calc(1% + 2%)', 'calc() evaluates to <percentage> which doesn\'t match the expected type <length>', 0],
    ['tab-size', 'calc(50% + 1)', 'Percentage is not allowed in this context', 0],
    ['flex-grow', 'calc(50% - 0.1)', 'Percentage is not allowed in this context', 0],
    ['transform', 'rotate(calc(10deg + 5%))', 'Percentage is not allowed in this context', 7],

    // vendor prefixed and case insensitive function names
    ['width', 'CALC(1px + 1s)', 'Incompatible types for "+" operator: <length> and <time>', 9],
    ['width', '-webkit-calc(1px + 1s)', 'Incompatible types for "+" operator: <length> and <time>', 17],
    ['width', 'MIN(1px, 1s)', 'Arguments of MIN() should have the same type, got <length> and <time>', 9]
];

describe('Lexer calc() expression matching', () => {
    describe('valid expressions should match', () => {
        for (const [property, value] of valid) {
            it(`${property}: ${value}`, () => {
                const match = lexer.matchProperty(property, value);

                assert(match.matched, match.error && match.error.message);
                assert.strictEqual(match.error, null);
            });
        }
    });

    describe('invalid expressions should not match', () => {
        for (const [property, value, message, offset] of invalid) {
            it(`${property}: ${value}`, () => {
                const { matched, error } = lexer.matchProperty(property, value);

                assert.strictEqual(matched, null);
                assert.notStrictEqual(error, null);
                assert.strictEqual(error.rawMessage, message);
                assert.strictEqual(error.mismatchOffset, offset, 'mismatchOffset');
            });
        }
    });

    describe('error should point to a problem sub-expression', () => {
        it('string value', () => {
            const { error } = lexer.matchProperty('width', 'calc(1px + 1s)');

            assert.strictEqual(error.mismatchOffset, 9);
            assert.strictEqual(error.mismatchLength, 1);
        });

        it('AST value with positions', () => {
            const ast = parse('.a { margin: calc(100% - 16px + 2s) }', { positions: true });
            let declaration = null;

            ast.children.first.block.children.forEach(node => declaration = node);

            const { matched, error } = lexer.matchDeclaration(declaration);

            assert.strictEqual(matched, null);
            assert.strictEqual(error.rawMessage, 'Incompatible types for "+" operator: <length> and <time>');
            assert.strictEqual(error.loc.start.offset, 30);
            assert.strictEqual(error.loc.start.column, 31);
        });
    });

    describe('var() and unresolvable values', () => {
        it('should keep var() behavior unchanged', () => {
            const { matched, error } = lexer.matchProperty('width', 'calc(1px + var(--x))');

            assert.strictEqual(matched, null);
            assert.strictEqual(error.message, 'Matching for a tree with var() is not supported');
        });

        it('should keep var() behavior unchanged for a whole value', () => {
            const { matched, error } = lexer.matchProperty('width', 'var(--x)');

            assert.strictEqual(matched, null);
            assert.strictEqual(error.message, 'Matching for a tree with var() is not supported');
        });
    });

    describe('matchType()', () => {
        it('should check an expression type', () => {
            assert(lexer.matchType('length', 'calc(1px + 1%)').matched);
            assert(lexer.matchType('length', 'calc(1px + 1%)').error === null);
            assert.strictEqual(lexer.matchType('length', 'calc(1px + 1s)').matched, null);
            assert.strictEqual(lexer.matchType('number', 'calc(1px + 1px)').matched, null);
            assert.strictEqual(lexer.matchType('percentage', 'calc(1px + 1px)').matched, null);
        });

        it('should not apply a percentage context check', () => {
            // a percentage in a type match context is allowed to be combined
            // with a dimension since a property context is unknown
            assert(lexer.matchType('length', 'calc(100% - 16px)').matched);
        });
    });

    describe('match()', () => {
        it('should report an expression error', () => {
            const { matched, error } = lexer.match('<length> | <angle>', 'calc(1px + 1deg)');

            assert.strictEqual(matched, null);
            assert.strictEqual(error.rawMessage, 'Incompatible types for "+" operator: <length> and <angle>');
            assert.strictEqual(error.mismatchOffset, 9);
        });
    });

    describe('custom units', () => {
        const customSyntax = fork({
            units: {
                length: ['px', 'xx']
            }
        });

        it('should respect custom units', () => {
            assert(customSyntax.lexer.matchProperty('width', 'calc(1xx + 1px)').matched);
            assert.strictEqual(customSyntax.lexer.matchProperty('width', 'calc(1xx + 1s)').matched, null);
        });
    });

    describe('css-wide keywords', () => {
        it('should still match', () => {
            assert(lexer.matchProperty('width', 'inherit').matched);
            assert(lexer.matchProperty('width', 'initial').matched);
        });
    });
});
