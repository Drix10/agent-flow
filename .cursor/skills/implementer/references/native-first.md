# Native first

Read this at `Lean level: full`, or whenever you are about to add a dependency or a hand-written helper. Before either, ask whether the platform, the standard library or the database already does it. This is a lookup table, not a rule to obey blindly: use the wrapper when it earns its place (an old browser, an edge case the built-in misses, ergonomics at scale) and say why in the report.

The idea and the shape of these tables come from [ponytail](https://github.com/DietrichGebert/ponytail) (MIT); the entries are written for this repo's checks. Verify a name against the version the repo targets before relying on it.

## Browser and CSS

| You reach for | What is already there |
|---|---|
| Date, time, colour or range picker library | `<input type="date">`, `"time"`, `"color"`, `"range"` |
| Modal library | `<dialog>` with `showModal()` |
| Accordion or FAQ component | `<details><summary>` |
| Searchable dropdown | `<input list>` with `<datalist>` |
| Progress or gauge component | `<progress>`, `<meter>` |
| Sticky header, smooth scroll, snap carousel | `position: sticky`, `scroll-behavior`, `scroll-snap-type` |
| Responsive sizing without breakpoints | `clamp()`, `grid-template-columns: repeat(auto-fill, minmax(…))`, `@container` |
| Dark mode, reduced motion | `prefers-color-scheme`, `prefers-reduced-motion` media queries |
| Theme tokens | CSS custom properties |

## JavaScript and Node

| You reach for | What is already there |
|---|---|
| `qs`, `query-string` | `URLSearchParams` |
| `lodash.clonedeep` | `structuredClone` |
| `lodash.groupby` | `Object.groupBy` (check the runtime version) |
| `uuid` (v4) | `crypto.randomUUID()` |
| `numeral`, `accounting`, most `date-fns` formatting | `Intl.NumberFormat`, `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat`, `Intl.PluralRules` |
| `clipboard.js` | `navigator.clipboard.writeText` |
| Infinite scroll or resize libraries | `IntersectionObserver`, `ResizeObserver` |
| Timeout wrapper around `fetch` | `AbortSignal.timeout(ms)` |
| `mkdirp`, `rimraf` | `fs.mkdirSync(p, { recursive: true })`, `fs.rmSync(p, { recursive: true, force: true })` |
| `array-uniq`, `array-flatten`, `object-assign` | `[...new Set(a)]`, `a.flat()`, spread |
| `load-json-file`, `path-exists` | `JSON.parse(fs.readFileSync(p, "utf8"))`, `fs.existsSync` |

## Python

| You reach for | What is already there |
|---|---|
| `pytz`, basic `python-dateutil` | `zoneinfo`, `datetime.fromisoformat` |
| `attrs` for plain records | `@dataclass` |
| `click` for one command | `argparse` |
| `six`, `pathlib2`, `enum34` | nothing: drop them (Python 3 has them) |
| `mergedeep`, `toolz` basics | `dict \| other`, `functools`, `itertools` |
| `requests` for one simple GET | `urllib.request`; keep `requests` for anything with retries, sessions or uploads |

## Database

Enforce it where the data lives, not in application code that every writer must remember.

| You write in the app | What the database has |
|---|---|
| Uniqueness, referential integrity, value ranges | `UNIQUE`, `FOREIGN KEY`, `CHECK` |
| Running totals, rank within a group | window functions (`SUM() OVER`, `RANK() OVER (PARTITION BY …)`) |
| Tree walks | recursive CTE |
| Dedupe on insert | `ON CONFLICT DO NOTHING` |
| Pagination | `LIMIT … OFFSET …` (keyset paging if the table is large) |
| Timestamps on insert and update | `DEFAULT now()`, trigger or `ON UPDATE` |

## When the wrapper is right

A dependency earns its place when the built-in is missing on a platform you support, is unsafe for the input you take, or the wrapper is the repo's established way (check first: `grep` the manifest and the imports). Never skip validation, escaping or an accessibility attribute because a native element looked simpler than the component that carried them.
