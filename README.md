# site-generator-speed

A faster drop-in for makefun-site 1.0.0: `solve.js` exports `run(input)`, returning byte-for-byte the answer the reference build returns, for every input. `main.ts` is the harness driver: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

Speed comes from fused Markdown lexing/rendering, a batched inline scanner, an ASCII fast path for slugs, slice-based front matter, and array-joined template output — same pipeline, same rules as the reference.
