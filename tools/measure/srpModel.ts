/**
 * A modelled eBay search-results page.
 *
 * www.ebay.ca answers this box with HTTP 403 (bot wall), so the 160 KB
 * search extract the deals run reported cannot be captured here. The
 * checked-in fixture can be, but it holds three cards with bare
 * `/itm/<id>?hash=abc` hrefs — two orders of magnitude short of a live
 * `_ipg=240` page, and short in exactly the dimension under
 * investigation (URL length). Measuring it and multiplying by 120 would
 * predict the wrong number for the wrong reason.
 *
 * So: a page is generated with the live card markup shape and href shape,
 * and the REAL extractor is run over it. Everything the extractor sees is
 * genuine; the input is modelled. Every modelled quantity is a named
 * constant below and is reported alongside the result, so the reader can
 * substitute their own figure and rescale rather than trust this one.
 */

/**
 * Live SRP anchors carry four tracking parameters past the item id. Lengths
 * are modelled from the documented shape of each:
 *   _skw     the search keywords, re-encoded per row
 *   itmmeta  a 26-character Crockford ULID
 *   hash     item<hex>:g:<11-char base64ish>
 *   itmprp   a percent-encoded opaque blob, the longest of the four
 * Change these and rerun; the ledger reports the mean href length it used.
 */
export const MODELLED_ITMPRP_LENGTH = 220;
export const MODELLED_KEYWORDS = 'bulk+lego+lot+mixed+bricks';
/** Bulk-lot SRP titles run long; eBay truncates around 80 characters. */
export const MODELLED_TITLE_LENGTH = 72;
/** `_ipg=240` is what a traversal asks for to cover a category in one page. */
export const MODELLED_ROWS_PER_PAGE = 240;

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Deterministic pseudo-random. A ledger that moves between runs cannot be
 * diffed against a later one, which is the whole point of capturing it.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function token(rng: () => number, length: number, alphabet: string): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(rng() * alphabet.length)];
  }
  return out;
}

const TITLE_WORDS = [
  'LEGO', 'Bulk', 'Lot', 'Mixed', 'Bricks', 'Parts', 'Pieces', 'Minifigures',
  'Star', 'Wars', 'City', 'Technic', 'Friends', 'Creator', 'Castle', 'Space',
  'lbs', 'kg', 'Assorted', 'Vintage', 'Genuine', 'Clean', 'Sorted', 'Bundle',
];

function title(rng: () => number, targetLength: number): string {
  const words: string[] = [];
  let length = 0;
  while (length < targetLength) {
    const word = TITLE_WORDS[Math.floor(rng() * TITLE_WORDS.length)]!;
    words.push(word);
    length += word.length + 1;
  }
  return words.join(' ').slice(0, targetLength).trim();
}

export interface SrpModelOptions {
  rows?: number;
  /** Emit `https://www.ebay.ca/itm/<id>` hrefs instead of tracked ones. */
  canonicalHrefs?: boolean;
  itmprpLength?: number;
  titleLength?: number;
  seed?: number;
}

export interface SrpModel {
  html: string;
  pageUrl: string;
  rows: number;
  meanHrefLength: number;
  meanTitleLength: number;
}

/**
 * Card markup mirrors tests/fixtures/ebay/search-results.html — the same
 * `li.s-item > a.s-item__link > h3.s-item__title` shape the checked-in
 * fixture uses, so the extractor takes the same path through it.
 */
export function buildSearchResultsPage(options: SrpModelOptions = {}): SrpModel {
  const rows = options.rows ?? MODELLED_ROWS_PER_PAGE;
  const itmprpLength = options.itmprpLength ?? MODELLED_ITMPRP_LENGTH;
  const titleLength = options.titleLength ?? MODELLED_TITLE_LENGTH;
  const rng = makeRng(options.seed ?? 20260829);

  const cards: string[] = [];
  let hrefLength = 0;
  let titleTotal = 0;

  for (let index = 0; index < rows; index += 1) {
    const itemId = `1${token(rng, 11, '0123456789')}`;
    const href = options.canonicalHrefs === true
      ? `https://www.ebay.ca/itm/${itemId}`
      : `https://www.ebay.ca/itm/${itemId}` +
        `?_skw=${MODELLED_KEYWORDS}` +
        `&itmmeta=${token(rng, 26, ULID_ALPHABET)}` +
        `&hash=item${token(rng, 12, BASE36)}:g:${token(rng, 11, BASE36)}` +
        `&itmprp=enc%3A${token(rng, itmprpLength, BASE36)}`;
    const cardTitle = title(rng, titleLength);
    hrefLength += href.length;
    titleTotal += cardTitle.length;
    const price = (10 + Math.floor(rng() * 490)).toFixed(2);
    cards.push(
      `    <li class="s-item">\n` +
        `      <a class="s-item__link" href="${href}">\n` +
        `        <h3 class="s-item__title">${cardTitle}</h3>\n` +
        `      </a>\n` +
        `      <span class="s-item__price">C $${price}</span>\n` +
        `    </li>`,
    );
  }

  const html =
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<title>bulk lego | eBay Search</title>\n</head>\n<body>\n` +
    `  <ul class="srp-results">\n${cards.join('\n')}\n  </ul>\n</body>\n</html>\n`;

  return {
    html,
    pageUrl: `https://www.ebay.ca/sch/i.html?_nkw=bulk+lego+lot&_ipg=${rows}`,
    rows,
    meanHrefLength: rows === 0 ? 0 : Math.round(hrefLength / rows),
    meanTitleLength: rows === 0 ? 0 : Math.round(titleTotal / rows),
  };
}
