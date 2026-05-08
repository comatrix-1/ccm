import { JSDOM } from 'jsdom';
import fc from 'fast-check';
import { extractLinks, extractTextContent } from '../pageExtractor.js';

/**
 * Helper: create a synthetic document from HTML string, with a base URL.
 */
function makeDoc(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/' });
  return dom.window.document;
}

// ---------------------------------------------------------------------------
// Unit tests — extractLinks()
// ---------------------------------------------------------------------------

describe('extractLinks()', () => {
  test('links with empty anchor text produce anchorText: ""', () => {
    const doc = makeDoc('<a href="https://example.com/page"></a>');
    const links = extractLinks(doc);
    expect(links).toHaveLength(1);
    expect(links[0].anchorText).toBe('');
  });

  test('relative hrefs are resolved to absolute URLs using document.baseURI', () => {
    const doc = makeDoc('<a href="/relative/path">Relative</a>');
    const links = extractLinks(doc);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/relative/path');
    expect(links[0].rawHref).toBe('/relative/path');
  });

  test('javascript: hrefs are excluded', () => {
    const doc = makeDoc('<a href="javascript:void(0)">Click</a>');
    const links = extractLinks(doc);
    expect(links).toHaveLength(0);
  });

  test('mailto: hrefs are excluded', () => {
    const doc = makeDoc('<a href="mailto:user@example.com">Email</a>');
    const links = extractLinks(doc);
    expect(links).toHaveLength(0);
  });

  test('tel: hrefs are excluded', () => {
    const doc = makeDoc('<a href="tel:+1234567890">Call</a>');
    const links = extractLinks(doc);
    expect(links).toHaveLength(0);
  });

  test('data: hrefs are excluded', () => {
    const doc = makeDoc('<a href="data:text/plain,hello">Data</a>');
    const links = extractLinks(doc);
    expect(links).toHaveLength(0);
  });

  test('fragment-only hrefs (#section) are excluded', () => {
    const doc = makeDoc('<a href="#section">Jump</a>');
    const links = extractLinks(doc);
    expect(links).toHaveLength(0);
  });

  test('duplicate URLs produce a single entry (first anchor text wins)', () => {
    const doc = makeDoc(`
      <a href="https://example.com/page">First</a>
      <a href="https://example.com/page">Second</a>
    `);
    const links = extractLinks(doc);
    expect(links).toHaveLength(1);
    expect(links[0].anchorText).toBe('First');
  });

  test('page with no <a> elements returns []', () => {
    const doc = makeDoc('<p>No links here</p>');
    const links = extractLinks(doc);
    expect(links).toEqual([]);
  });

  test('returns correct rawHref alongside resolved url', () => {
    const doc = makeDoc('<a href="https://other.com/page">External</a>');
    const links = extractLinks(doc);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://other.com/page');
    expect(links[0].rawHref).toBe('https://other.com/page');
    expect(links[0].anchorText).toBe('External');
  });
});

// ---------------------------------------------------------------------------
// Property test — extractLinks() — Property 1: Link extraction completeness
// Feature: course-content-monitor, Property 1: Link extraction completeness
// ---------------------------------------------------------------------------

describe('extractLinks() — Property 1: Link extraction completeness', () => {
  test('for any array of valid hrefs, result has at most N entries with no duplicate URLs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.webUrl(), { minLength: 0, maxLength: 20 }),
        (hrefs) => {
          // Build synthetic HTML with one <a> per href
          const anchors = hrefs
            .map((href, i) => `<a href="${href}">Link ${i}</a>`)
            .join('\n');
          const doc = makeDoc(`<body>${anchors}</body>`);

          const links = extractLinks(doc);

          // Result length must be ≤ input length
          expect(links.length).toBeLessThanOrEqual(hrefs.length);

          // No duplicate resolved URLs
          const urls = links.map((l) => l.url);
          const uniqueUrls = new Set(urls);
          expect(uniqueUrls.size).toBe(urls.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — extractTextContent()
// ---------------------------------------------------------------------------

describe('extractTextContent()', () => {
  test('text inside <script> is excluded', () => {
    const doc = makeDoc('<body><script>var x = 1;</script><p>Visible</p></body>');
    const text = extractTextContent(60000, doc);
    expect(text).not.toContain('var x = 1');
    expect(text).toContain('Visible');
  });

  test('text inside <style> is excluded', () => {
    const doc = makeDoc('<body><style>body { color: red; }</style><p>Visible</p></body>');
    const text = extractTextContent(60000, doc);
    expect(text).not.toContain('color: red');
    expect(text).toContain('Visible');
  });

  test('text inside elements with display:none is excluded', () => {
    const doc = makeDoc(
      '<body><div style="display:none">Hidden text</div><p>Visible text</p></body>'
    );
    const text = extractTextContent(60000, doc);
    expect(text).not.toContain('Hidden text');
    expect(text).toContain('Visible text');
  });

  test('text inside elements with aria-hidden="true" is excluded', () => {
    const doc = makeDoc(
      '<body><span aria-hidden="true">Screen reader hidden</span><p>Visible</p></body>'
    );
    const text = extractTextContent(60000, doc);
    expect(text).not.toContain('Screen reader hidden');
    expect(text).toContain('Visible');
  });

  test('visible text is included and whitespace is normalised', () => {
    const doc = makeDoc('<body><p>Hello   world</p><p>  Foo  </p></body>');
    const text = extractTextContent(60000, doc);
    // Multiple spaces should be collapsed
    expect(text).toContain('Hello world');
    expect(text).toContain('Foo');
  });

  test('output is truncated to maxChars', () => {
    const longText = 'A'.repeat(200);
    const doc = makeDoc(`<body><p>${longText}</p></body>`);
    const text = extractTextContent(100, doc);
    expect(text.length).toBeLessThanOrEqual(100);
  });

  test('page with no visible text returns ""', () => {
    const doc = makeDoc('<body></body>');
    const text = extractTextContent(60000, doc);
    expect(text).toBe('');
  });
});
