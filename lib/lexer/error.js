import { createCustomError } from '../utils/create-custom-error.js';
import { generate } from '../definition-syntax/generate.js';

const defaultLoc = { offset: 0, line: 1, column: 1 };

function locateMismatch(matchResult, node) {
    const tokens = matchResult.tokens;
    const longestMatch = matchResult.longestMatch;
    const mismatchNode = longestMatch < tokens.length ? tokens[longestMatch].node || null : null;
    const badNode = mismatchNode !== node ? mismatchNode : null;
    let mismatchOffset = 0;
    let mismatchLength = 0;
    let entries = 0;
    let css = '';
    let start;
    let end;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i].value;

        if (i === longestMatch) {
            mismatchLength = token.length;
            mismatchOffset = css.length;
        }

        if (badNode !== null && tokens[i].node === badNode) {
            if (i <= longestMatch) {
                entries++;
            } else {
                entries = 0;
            }
        }

        css += token;
    }

    if (longestMatch === tokens.length || entries > 1) { // last
        start = fromLoc(badNode || node, 'end') || buildLoc(defaultLoc, css);
        end = buildLoc(start);
    } else {
        start = fromLoc(badNode, 'start') ||
            buildLoc(fromLoc(node, 'start') || defaultLoc, css.slice(0, mismatchOffset));
        end = fromLoc(badNode, 'end') ||
            buildLoc(start, css.substr(mismatchOffset, mismatchLength));
    }

    return {
        css,
        mismatchOffset,
        mismatchLength,
        start,
        end
    };
}

function fromLoc(node, point) {
    const value = node && node.loc && node.loc[point];

    if (value) {
        return 'line' in value ? buildLoc(value) : value;
    }

    return null;
}

function buildLoc({ offset, line, column }, extra) {
    const loc = {
        offset,
        line,
        column
    };

    if (extra) {
        const lines = extra.split(/\n|\r\n?|\f/);

        loc.offset += extra.length;
        loc.line += lines.length - 1;
        loc.column = lines.length === 1 ? loc.column + extra.length : lines.pop().length + 1;
    }

    return loc;
}

export const SyntaxReferenceError = function(type, referenceName) {
    const error = createCustomError(
        'SyntaxReferenceError',
        type + (referenceName ? ' `' + referenceName + '`' : '')
    );

    error.reference = referenceName;

    return error;
};

export const SyntaxMathError = function(message, syntax, node, matchResult, range) {
    const error = createCustomError('SyntaxMatchError', message);
    const tokens = matchResult.tokens;
    const css = tokens.reduce((result, token) => result + token.value, '');
    const startToken = range && range.startToken;
    const endToken = range && range.endToken;

    // Find the token range within the prepared token list
    let mismatchOffset = 0;
    let mismatchLength = 0;

    if (startToken) {
        const startIndex = tokens.indexOf(startToken);
        const endIndex = endToken ? tokens.indexOf(endToken) : startIndex;

        if (startIndex !== -1 && endIndex !== -1) {
            for (let i = 0; i < startIndex; i++) {
                mismatchOffset += tokens[i].value.length;
            }

            for (let i = startIndex; i <= endIndex; i++) {
                mismatchLength += tokens[i].value.length;
            }
        }
    }

    // Prefer the location of the AST node of the offending sub-expression.
    // For string values there are no nodes, so locations are computed.
    const startNode = startToken && startToken.node;
    const endNode = endToken && endToken.node;
    const start = fromLoc(startNode, 'start') ||
        buildLoc(fromLoc(node, 'start') || defaultLoc, css.slice(0, mismatchOffset));
    const end = (endNode && endNode !== startNode && fromLoc(endNode, 'end')) ||
        buildLoc(start, css.substr(mismatchOffset, mismatchLength));

    error.rawMessage = message;
    error.syntax = syntax ? generate(syntax) : '<generic>';
    error.css = css;
    error.mismatchOffset = mismatchOffset;
    error.mismatchLength = mismatchLength;
    error.message = message + '\n' +
        '  syntax: ' + error.syntax + '\n' +
        '   value: ' + (css || '<empty string>') + '\n' +
        '  --------' + new Array(error.mismatchOffset + 1).join('-') + '^';

    Object.assign(error, start);
    error.loc = {
        source: (node && node.loc && node.loc.source) || '<unknown>',
        start,
        end
    };

    return error;
};

export const SyntaxMatchError = function(message, syntax, node, matchResult) {
    const error = createCustomError('SyntaxMatchError', message);
    const {
        css,
        mismatchOffset,
        mismatchLength,
        start,
        end
    } = locateMismatch(matchResult, node);

    error.rawMessage = message;
    error.syntax = syntax ? generate(syntax) : '<generic>';
    error.css = css;
    error.mismatchOffset = mismatchOffset;
    error.mismatchLength = mismatchLength;
    error.message = message + '\n' +
        '  syntax: ' + error.syntax + '\n' +
        '   value: ' + (css || '<empty string>') + '\n' +
        '  --------' + new Array(error.mismatchOffset + 1).join('-') + '^';

    Object.assign(error, start);
    error.loc = {
        source: (node && node.loc && node.loc.source) || '<unknown>',
        start,
        end
    };

    return error;
};
