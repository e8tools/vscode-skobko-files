import * as assert from 'assert';
import { tokenize, parseGuidsMarkdown, isDigit, isDigitOrDateChar, isBase64Char } from '../src/parser';

describe('tokenize', () => {
  it('should tokenize empty string', () => {
    const tokens = tokenize('');
    assert.strictEqual(tokens.length, 0);
  });

  it('should tokenize braces', () => {
    const tokens = tokenize('{}');
    assert.strictEqual(tokens.length, 2);
    assert.strictEqual(tokens[0].kind, 'lbrace');
    assert.strictEqual(tokens[1].kind, 'rbrace');
  });

  it('should tokenize nested braces', () => {
    const tokens = tokenize('{{}}');
    assert.strictEqual(tokens.length, 4);
    assert.strictEqual(tokens[0].kind, 'lbrace');
    assert.strictEqual(tokens[1].kind, 'lbrace');
    assert.strictEqual(tokens[2].kind, 'rbrace');
    assert.strictEqual(tokens[3].kind, 'rbrace');
  });

  it('should tokenize comma', () => {
    const tokens = tokenize(',');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'comma');
  });

  it('should tokenize whitespace', () => {
    const tokens = tokenize('  \t\n');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'whitespace');
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 4);
  });

  it('should tokenize string', () => {
    const tokens = tokenize('"hello"');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'string');
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 7);
  });

  it('should tokenize string with escaped quote', () => {
    const tokens = tokenize('"hello\\"world"');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'string');
  });

  it('should tokenize GUID', () => {
    const guid = '12345678-1234-1234-1234-123456789abc';
    const tokens = tokenize(guid);
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'guid');
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 36);
  });

  it('should tokenize uppercase GUID', () => {
    const guid = 'ABCDEF12-3456-7890-ABCD-EF1234567890';
    const tokens = tokenize(guid);
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'guid');
  });

  it('should tokenize number', () => {
    const tokens = tokenize('12345');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'number');
  });

  it('should tokenize negative number', () => {
    const tokens = tokenize('-123');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'number');
  });

  it('should tokenize datetime as 14 digits', () => {
    const tokens = tokenize('20240115103000');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'datetime');
    assert.strictEqual(tokens[0].start, 0);
    assert.strictEqual(tokens[0].end, 14);
  });

  it('should tokenize datetime with leading zeros', () => {
    const tokens = tokenize('00010101000000');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'datetime');
    assert.strictEqual(tokens[0].end, 14);
  });

  it('should tokenize 13 digits as number, not datetime', () => {
    const tokens = tokenize('1234567890123');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'number');
  });

  it('should tokenize 15 digits as number, not datetime', () => {
    const tokens = tokenize('123456789012345');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].kind, 'number');
  });

  it('should tokenize complex structure', () => {
    const input = '{"hello", 123, 12345678-1234-1234-1234-123456789abc}';
    const tokens = tokenize(input);
    
    const kinds = tokens.map(t => t.kind);
    assert.deepStrictEqual(kinds, [
      'lbrace',
      'string',
      'comma',
      'whitespace',
      'number',
      'comma',
      'whitespace',
      'guid',
      'rbrace'
    ]);
  });

  it('should preserve correct positions', () => {
    const input = '{1,2}';
    const tokens = tokenize(input);
    
    assert.strictEqual(tokens[0].start, 0); // {
    assert.strictEqual(tokens[0].end, 1);
    assert.strictEqual(tokens[1].start, 1); // 1
    assert.strictEqual(tokens[1].end, 2);
    assert.strictEqual(tokens[2].start, 2); // ,
    assert.strictEqual(tokens[2].end, 3);
    assert.strictEqual(tokens[3].start, 3); // 2
    assert.strictEqual(tokens[3].end, 4);
    assert.strictEqual(tokens[4].start, 4); // }
    assert.strictEqual(tokens[4].end, 5);
  });
});

describe('parseGuidsMarkdown', () => {
  it('should return empty map for empty string', () => {
    const map = parseGuidsMarkdown('');
    assert.strictEqual(map.size, 0);
  });

  it('should parse single GUID entry', () => {
    const markdown = '| 12345678-1234-1234-1234-123456789abc | SomeName |';
    const map = parseGuidsMarkdown(markdown);
    assert.strictEqual(map.size, 1);
    assert.strictEqual(map.get('12345678-1234-1234-1234-123456789abc'), 'SomeName');
  });

  it('should parse multiple GUID entries', () => {
    const markdown = `
| GUID | Name |
|------|------|
| 11111111-1111-1111-1111-111111111111 | First |
| 22222222-2222-2222-2222-222222222222 | Second |
`;
    const map = parseGuidsMarkdown(markdown);
    assert.strictEqual(map.size, 2);
    assert.strictEqual(map.get('11111111-1111-1111-1111-111111111111'), 'First');
    assert.strictEqual(map.get('22222222-2222-2222-2222-222222222222'), 'Second');
  });

  it('should lowercase GUID keys', () => {
    const markdown = '| ABCDEF12-3456-7890-ABCD-EF1234567890 | Test |';
    const map = parseGuidsMarkdown(markdown);
    assert.strictEqual(map.get('abcdef12-3456-7890-abcd-ef1234567890'), 'Test');
  });

  it('should skip lines without pipes', () => {
    const markdown = `
Some text without pipes
| 12345678-1234-1234-1234-123456789abc | ValidName |
Another line
`;
    const map = parseGuidsMarkdown(markdown);
    assert.strictEqual(map.size, 1);
  });

  it('should skip invalid GUID format', () => {
    const markdown = '| Name | not-a-valid-guid |';
    const map = parseGuidsMarkdown(markdown);
    assert.strictEqual(map.size, 0);
  });

  it('should skip header separator row', () => {
    const markdown = '|------|------|';
    const map = parseGuidsMarkdown(markdown);
    assert.strictEqual(map.size, 0);
  });
});

describe('isDigit', () => {
  it('should return true for digits', () => {
    for (let i = 0; i <= 9; i++) {
      assert.strictEqual(isDigit(String(i)), true, `Failed for ${i}`);
    }
  });

  it('should return false for non-digits', () => {
    assert.strictEqual(isDigit('a'), false);
    assert.strictEqual(isDigit('Z'), false);
    assert.strictEqual(isDigit('-'), false);
    assert.strictEqual(isDigit(' '), false);
  });
});

describe('isDigitOrDateChar', () => {
  it('should return true for digits', () => {
    for (let i = 0; i <= 9; i++) {
      assert.strictEqual(isDigitOrDateChar(String(i)), true, `Failed for ${i}`);
    }
  });

  it('should return false for non-digits', () => {
    assert.strictEqual(isDigitOrDateChar('-'), false);
    assert.strictEqual(isDigitOrDateChar(':'), false);
    assert.strictEqual(isDigitOrDateChar('T'), false);
    assert.strictEqual(isDigitOrDateChar('Z'), false);
    assert.strictEqual(isDigitOrDateChar('.'), false);
    assert.strictEqual(isDigitOrDateChar('+'), false);
    assert.strictEqual(isDigitOrDateChar('/'), false);
    assert.strictEqual(isDigitOrDateChar('a'), false);
    assert.strictEqual(isDigitOrDateChar(' '), false);
  });
});

describe('isBase64Char', () => {
  it('should return true for uppercase letters', () => {
    assert.strictEqual(isBase64Char('A'), true);
    assert.strictEqual(isBase64Char('Z'), true);
  });

  it('should return true for lowercase letters', () => {
    assert.strictEqual(isBase64Char('a'), true);
    assert.strictEqual(isBase64Char('z'), true);
  });

  it('should return true for digits', () => {
    assert.strictEqual(isBase64Char('0'), true);
    assert.strictEqual(isBase64Char('9'), true);
  });

  it('should return true for base64 special chars', () => {
    assert.strictEqual(isBase64Char('+'), true);
    assert.strictEqual(isBase64Char('/'), true);
    assert.strictEqual(isBase64Char('='), true);
  });

  it('should return false for other chars', () => {
    assert.strictEqual(isBase64Char('-'), false);
    assert.strictEqual(isBase64Char(' '), false);
    assert.strictEqual(isBase64Char('@'), false);
  });
});
