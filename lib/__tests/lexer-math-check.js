import assert from 'assert';
import { parse, lexer, createLexer, fork, walk } from 'css-tree';

function matchProperty(property, value) {
    return lexer.matchProperty(property, typeof value === 'string'
        ? parse(value, { context: 'value', positions: true })
        : value
    );
}

function assertValid(property, value) {
    const result = matchProperty(property, value);

    assert.strictEqual(
        result.error,
        null,
        property + ': ' + value + ' should be valid' + (result.error ? ' (' + result.error.rawMessage + ')' : '')
    );
    assert.notStrictEqual(result.matched, null);
}

function assertInvalid(property, value, message) {
    const result = matchProperty(property, value);

    assert.strictEqual(result.matched, null, property + ': ' + value + ' should be invalid');
    assert.strictEqual(result.error.name, 'SyntaxMatchError');

    if (message) {
        assert.match(result.error.rawMessage, message);
    }

    return result.error;
}

describe('Lexer math expression type checking', () => {
    describe('the reported incident', () => {
        it('rejects a percentage combined with a unitless number', () => {
            assertInvalid('width', 'calc(100% - 16)', /percentage.*number/);
        });

        it('accepts the same expression with a unit', () => {
            assertValid('width', 'calc(100% - 16px)');
        });
    });

    describe('addition and subtraction', () => {
        it('accepts matching dimensions', () => {
            assertValid('margin', 'calc(16px + 2em)');
            assertValid('margin-top', 'calc(10px - 5px)');
            assertValid('animation-duration', 'calc(1s + 200ms)');
            assertValid('transform', 'rotate(calc(10deg + 1turn))');
        });

        it('accepts matching numbers and percentages', () => {
            assertValid('opacity', 'calc(1 - 0.1)');
            assertValid('width', 'calc(100% - 20%)');
        });

        it('rejects different dimensions', () => {
            assertInvalid('margin', 'calc(16px + 2s)', /length.*time/);
            assertInvalid('animation-duration', 'calc(1s - 1px)', /time.*length/);
            assertInvalid('transform', 'rotate(calc(10deg + 5))', /angle.*number/);
        });

        it('rejects a dimension combined with a unitless number', () => {
            assertInvalid('margin-top', 'calc(16px + 16)', /length.*number/);
            assertInvalid('margin', 'calc(16 - 16px)', /number.*length/);
        });

        it('treats a unitless zero as the additive identity', () => {
            assertValid('width', 'calc(0 + 16px)');
            assertValid('width', 'calc(100% - 0)');
            assertValid('width', 'calc(0)');
        });
    });

    describe('multiplication', () => {
        it('accepts when one operand is a number', () => {
            assertValid('width', 'calc(2 * 16px)');
            assertValid('width', 'calc(16px * 2)');
            assertValid('animation-duration', 'calc(200ms * 3)');
        });

        it('rejects dimension times dimension', () => {
            assertInvalid('width', 'calc(16px * 2em)', /Multiplication/);
            assertInvalid('width', 'calc(50% * 1px)', /Multiplication/);
        });
    });

    describe('division', () => {
        it('accepts a numeric divisor', () => {
            assertValid('width', 'calc(16px / 2)');
            assertValid('width', 'calc((100% - 16px) / 2)');
        });

        it('rejects a non-numeric divisor', () => {
            assertInvalid('width', 'calc(16px / 2em)', /Division/);
            assertInvalid('width', 'calc(50% / 1px)', /Division/);
        });

        it('rejects division by a literal zero', () => {
            assertInvalid('width', 'calc(100px / 0)', /Division by zero/);
            assertInvalid('width', 'calc(100px / -0)', /Division by zero/);
        });

        it('rejects division by a provably zero expression', () => {
            assertInvalid('width', 'calc(100px / (1 * 0))', /Division by zero/);
            assertInvalid('width', 'calc(100px / (2 - 2))', /Division by zero/);
            assertInvalid('width', 'calc(100px / calc(1 - 1))', /Division by zero/);
            assertInvalid('width', 'calc(100px / clamp(0, 0, 0))', /Division by zero/);
        });

        it('does not treat min(0, 1) as zero', () => {
            assertValid('width', 'calc(100px / min(0, 1))');
        });

        it('passes when the divisor value cannot be determined', () => {
            // var() makes the whole value skip matching; env()/attr() and
            // expressions containing them are unknown and must not be rejected
            assertValid('width', 'calc(100px / env(safe-area-inset-left))');
            assertValid('width', 'calc(100px / attr(data-x number, 1))');
            assertValid('width', 'calc(100px / (1 + env(unknown)))');
        });
    });

    describe('min(), max() and clamp()', () => {
        it('accepts matching arguments', () => {
            assertValid('width', 'min(1px, 2em, 3rem)');
            assertValid('width', 'max(10%, 20px)');
            assertValid('width', 'clamp(1px, 2em, 3px)');
        });

        it('rejects arguments of different dimensions', () => {
            assertInvalid('width', 'min(1px, 2s)', /Arguments of `min\(\)`/);
            assertInvalid('width', 'max(1px, 2deg)', /Arguments of `max\(\)`/);
            assertInvalid('width', 'clamp(1px, 2em, 3s)', /Arguments of `clamp\(\)`/);
        });

        it('rejects bad arity', () => {
            assertInvalid('width', 'clamp(1px, 2px)', /clamp\(\).*3 arguments/);
            assertInvalid('width', 'min()', /at least 1 argument/);
        });

        it('allows a unitless zero argument to adapt to any type', () => {
            assertValid('width', 'min(0, 1px)');
            assertValid('width', 'max(0, 100%, 1px)');
        });
    });

    describe('nested expressions', () => {
        it('infers types bottom-up through calc nesting', () => {
            assertValid('width', 'calc(1px + calc(2px + 3px))');
            assertValid('width', 'max(10px, min(20px, 30em))');
            assertValid('width', 'clamp(0px, calc(50% / 2), 100px)');
        });

        it('reports the innermost offending sub-expression', () => {
            assertInvalid('width', 'calc(1px + calc(2px + 3s))', /length.*time/);
            assertInvalid('width', 'min(1px, max(2px, 3s))', /length.*time/);
            assertInvalid('width', 'calc(1px + calc(2px + calc(3px + 4s)))', /length.*time/);
            assertInvalid('width', 'clamp(1px, 2em, calc(3px * 4px))', /Multiplication/);
        });

        it('points the error span at the offending operand', () => {
            const ast = parse('a{ width: calc(1px + calc(2px + 3s)); }', { positions: true });
            let declaration;

            walk(ast, {
                visit: 'Declaration',
                enter(node) {
                    declaration = node;
                }
            });

            const result = lexer.matchDeclaration(declaration);

            assert.strictEqual(result.matched, null);

            const css = result.error.css;
            const fragment = css.substr(result.error.mismatchOffset, result.error.mismatchLength);

            assert.strictEqual(fragment, '3s');
        });
    });

    describe('percentages are resolved per property', () => {
        it('mix percentages with lengths for length-percentage properties', () => {
            assertValid('width', 'calc(100% - 16px)');
            assertValid('padding', 'clamp(0px, 5%, 10px)');
            assertValid('margin', 'calc(50% - 1px)');
            assertValid('background-position', 'calc(10% + 1px)');
        });

        it('rejects mixing for length-only properties', () => {
            assertInvalid('border-top-width', 'calc(100% - 16px)', /percentage.*length/);
        });

        it('accepts a pure percentage result wherever the property accepts percentages', () => {
            assertValid('line-height', 'calc(2 * 50%)');
            assertValid('width', 'min(50%, 50%)');
        });

        it('does not mix separate alternatives of a multi-branch syntax', () => {
            // line-height: <number> | <length> | <percentage>
            assertInvalid('line-height', 'calc(100% - 1px)', /percentage.*length/);
            assertInvalid('line-height', 'calc(1 + 1px)', /number.*length/);
        });

        it('rejects a result type none of the branches accept', () => {
            assertInvalid('zoom', 'calc(1px)', /length.*number/);
        });

        it('resolves a percentage to a number in a shared value space (zoom)', () => {
            assertValid('zoom', 'calc(1 + 50%)');
        });

        it('keeps number and percentage separate for opacity', () => {
            assertInvalid('opacity', 'calc(1 + 50%)', /number.*percentage/);
        });
    });

    describe('unknown operands', () => {
        it('skips a value containing var() (matching is not supported at all)', () => {
            const result = lexer.matchProperty('width', 'calc(var(--x) + 1px)');

            assert.strictEqual(result.matched, null);
            assert.match(result.error.message, /var\(\) is not supported/);
        });

        it('does not infer errors from unknown-typed inner expressions', () => {
            assertValid('width', 'calc(env(safe-area-inset-left) + 1px)');
            assertValid('width', 'calc(1px + env(x) + 2px)');
            assertValid('width', 'min(env(a), env(b), 50%)');
        });
    });

    describe('result type checking', () => {
        it('rejects a dimension for a number property', () => {
            assertInvalid('z-index', 'calc(1px + 2px)', /length.*integer/);
            assertInvalid('column-count', 'calc(1px)', /length.*integer/);
        });

        it('accepts a number for a number property', () => {
            assertValid('z-index', 'calc(10 + 2)');
            assertValid('aspect-ratio', 'calc(16 / 9)');
        });
    });

    describe('contexts without a property', () => {
        it('keeps the lenient <length> behaviour for type matching (backward compat)', () => {
            assert.strictEqual(lexer.matchType('length', 'calc(1px + 1%)').matched !== null, true);
            assert.strictEqual(lexer.matchType('length', 'calc(2 * 1px)').matched !== null, true);
        });

        it('still enforces property-independent rules for type matching', () => {
            assert.strictEqual(lexer.matchType('length', 'calc(1px + 1s)').matched, null);
            assert.strictEqual(lexer.matchType('length', 'calc(1px * 2em)').matched, null);
            assert.strictEqual(lexer.matchType('length', 'calc(1px / 0)').matched, null);
        });

        it('checks media feature values but does not resolve percentages', () => {
            assert.strictEqual(
                lexer.matchAtrulePrelude('media', '(min-width: calc(100% - 10px))').matched !== null,
                true
            );
            assert.strictEqual(
                lexer.matchAtrulePrelude('media', '(min-width: calc(100px / 0))').matched,
                null
            );
        });
    });

    describe('custom lexers', () => {
        it('honours custom units', () => {
            const customLexer = createLexer({
                generic: true,
                units: {
                    length: ['px', 'foo']
                }
            });

            assert.strictEqual(customLexer.matchType('length', 'calc(2 * 1foo)').matched !== null, true);
        });

        it('resolves percentages against custom property syntax', () => {
            const customLexer = createLexer({
                generic: true,
                types: {
                    // percentage and length share a value space, same as
                    // the spec definition of <length-percentage>
                    'my-length-percentage': '<length> | <percentage>'
                },
                properties: {
                    'my-gap': '<my-length-percentage>',
                    'my-width': '<length>'
                }
            });

            assert.strictEqual(customLexer.matchProperty('my-gap', 'calc(100% - 16px)').matched !== null, true,
                'percentage mixes with the accepted dimension');
            assert.strictEqual(customLexer.matchProperty('my-gap', 'calc(100% - 16)').matched, null,
                'percentage does not mix with a unitless number');
            assert.strictEqual(customLexer.matchProperty('my-gap', 'calc(100%)').matched !== null, true,
                'a pure percentage is accepted');
            assert.strictEqual(customLexer.matchProperty('my-gap', 'calc(16px)').matched !== null, true,
                'a pure length is accepted');
            assert.strictEqual(customLexer.matchProperty('my-width', 'calc(100% - 16px)').matched, null,
                'length-only syntax does not accept percentages');
        });

        it('works with a forked lexer', () => {
            const customLexer = fork({
                properties: {
                    '-custom-width': '<length-percentage>'
                }
            });

            assert.strictEqual(customLexer.lexer.matchProperty('-custom-width', 'calc(100% - 16)').matched, null);
            assert.strictEqual(customLexer.lexer.matchProperty('-custom-width', 'calc(100% - 16px)').matched !== null, true);
        });
    });

    describe('vendor prefixes', () => {
        it('checks -webkit-calc and -moz-calc', () => {
            assertValid('width', '-webkit-calc(100% - 16px)');
            assertInvalid('width', '-webkit-calc(100% - 16)', /percentage.*number/);
        });
    });
});
