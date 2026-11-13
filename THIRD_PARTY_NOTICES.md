# Third-party notices

This file lists third-party work in this repository. CLAUDE.md §9: reused MIT or Apache-2.0 code is added here in the same pull request, with its source URL, commit and licence; `pnpm licences` fails CI on GPL, AGPL, LGPL, SSPL, FSL, BUSL and unknown licences.

## Code copied into this repository

None. Concepts studied in other projects (research report §5) were reimplemented; no code, assets, layouts or text were copied. Restricted projects (Botpress v12, Typebot, Dify, Hexabot, n8n, Flowise `enterprise/`, LLMz) are not vendored or cloned.

## Assets shipped with the Studio

| Asset | Licence | Source | Used for |
|---|---|---|---|
| IBM Plex Sans, IBM Plex Sans Arabic, IBM Plex Mono (weights 400, 500, 600) | SIL Open Font License 1.1 | https://github.com/IBM/plex, packaged by @fontsource | Studio type (design system §2.2) |
| Lucide icons | ISC | https://lucide.dev | Studio icons (design system §2.3) |

## Development infrastructure (not distributed)

Container images used by `docker-compose.yml` and the tests: pgvector/pgvector (PostgreSQL License, pgvector MIT), Redis 7.2 (BSD-3-Clause), RustFS (Apache-2.0).

## Installed packages

<!-- BEGIN GENERATED: pnpm licences --write -->

348 packages installed by `pnpm install` (runtime and development), not counting platform builds.

### MIT (265)

- @babel/helper-string-parser 7.29.14 — https://babel.dev/docs/en/next/babel-helper-string-parser
- @babel/helper-validator-identifier 7.29.7
- @babel/parser 7.29.14 — https://babel.dev/docs/en/next/babel-parser
- @babel/types 7.29.14 — https://babel.dev/docs/en/next/babel-types
- @bcoe/v8-coverage 1.0.2
- @better-auth/core 1.7.23 — https://www.better-auth.com
- @better-auth/drizzle-adapter 1.7.23 — https://www.better-auth.com/docs/adapters/drizzle
- @better-auth/kysely-adapter 1.7.23 — https://www.better-auth.com/docs/adapters/kysely
- @better-auth/memory-adapter 1.7.23 — https://www.better-auth.com
- @better-auth/mongo-adapter 1.7.23 — https://www.better-auth.com/docs/adapters/mongodb
- @better-auth/prisma-adapter 1.7.23 — https://www.better-auth.com/docs/adapters/prisma
- @better-auth/telemetry 1.7.23 — https://www.better-auth.com
- @better-auth/utils 0.5.1
- @better-fetch/fetch 1.3.3
- @fastify/ajv-compiler 4.0.7 — https://github.com/fastify/ajv-compiler#readme
- @fastify/deepmerge 3.2.4 — https://github.com/fastify/deepmerge#readme
- @fastify/error 4.2.1 — https://github.com/fastify/fastify-error#readme
- @fastify/fast-json-stringify-compiler 5.2.0 — https://github.com/fastify/fast-json-stringify-compiler#readme
- @fastify/forwarded 3.1.2 — https://github.com/fastify/forwarded#readme
- @fastify/merge-json-schemas 0.2.2 — https://github.com/fastify/merge-json-schemas#readme
- @fastify/proxy-addr 5.1.2 — https://github.com/fastify/proxy-addr#readme
- @ioredis/commands 2.0.0 — https://github.com/ioredis/commands
- @jridgewell/gen-mapping 0.3.13 — https://github.com/jridgewell/sourcemaps/tree/main/packages/gen-mapping
- @jridgewell/remapping 2.3.5 — https://github.com/jridgewell/sourcemaps/tree/main/packages/remapping
- @jridgewell/resolve-uri 3.1.3
- @jridgewell/sourcemap-codec 1.6.0 — https://github.com/jridgewell/sourcemaps/tree/main/packages/sourcemap-codec
- @jridgewell/trace-mapping 0.3.31 — https://github.com/jridgewell/sourcemaps/tree/main/packages/trace-mapping
- @js-sdsl/ordered-map 4.4.2 — https://js-sdsl.org
- @kwsites/file-exists 1.1.1
- @noble/ciphers 2.4.0 — https://paulmillr.com/noble/
- @noble/hashes 2.4.0 — https://paulmillr.com/noble/
- @oxc-project/types 0.156.0 — https://oxc.rs
- @parcel/watcher 2.6.0
- @pinojs/redact 0.4.0 — https://github.com/pinojs/redact#readme
- @pkgjs/parseargs 0.11.0 — https://github.com/pkgjs/parseargs#readme
- @rolldown/pluginutils 1.1.1 — https://github.com/rolldown/plugins/tree/main/packages/pluginutils#readme
- @standard-schema/spec 1.1.0 — https://standardschema.dev
- @tailwindcss/cli 4.3.5 — https://tailwindcss.com
- @tailwindcss/node 4.3.5 — https://tailwindcss.com
- @tailwindcss/oxide 4.3.5
- @tailwindcss/oxide-wasm32-wasi 4.3.5
- @tailwindcss/vite 4.3.5 — https://tailwindcss.com
- @tanstack/history 1.162.5 — https://tanstack.com/router
- @tanstack/react-router 1.170.46 — https://tanstack.com/router
- @tanstack/react-store 0.11.2 — https://tanstack.com/store
- @tanstack/router-core 1.171.39 — https://tanstack.com/router
- @tanstack/store 0.11.2 — https://tanstack.com/store
- @testcontainers/postgresql 12.2.1 — https://github.com/testcontainers/testcontainers-node#readme
- @testcontainers/redis 12.2.1 — https://github.com/testcontainers/testcontainers-node#readme
- @types/chai 5.2.3 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/chai
- @types/deep-eql 4.0.2 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/deep-eql
- @types/docker-modem 3.0.6 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/docker-modem
- @types/dockerode 4.0.2 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/dockerode
- @types/estree 1.0.10 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/estree
- @types/node 18.19.130 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node
- @types/node 22.20.5 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node
- @types/pg 8.23.1 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/pg
- @types/react 19.3.0 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react
- @types/react-dom 19.3.0 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react-dom
- @types/ssh2 0.5.52 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/ssh2
- @types/ssh2 1.15.6 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/ssh2
- @types/ssh2-streams 0.1.13 — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/ssh2-streams
- @vitejs/plugin-react 6.3.0 — https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#readme
- @vitest/coverage-v8 5.1.0 — https://vitest.dev/guide/coverage
- @vitest/istanbul-lib-coverage 2.1.0 — https://vitest.dev/
- @vitest/istanbul-lib-report 2.1.0 — https://vitest.dev
- @vitest/mocker 5.1.0 — https://github.com/vitest-dev/vitest/tree/main/packages/mocker
- @vitest/spy 5.1.0 — https://vitest.dev/api/mock
- abort-controller 3.0.0 — https://github.com/mysticatea/abort-controller#readme
- abstract-logging 2.0.1 — https://github.com/jsumners/abstract-logging#readme
- ajv 8.20.0 — https://ajv.js.org
- ajv-formats 3.0.1 — https://github.com/ajv-validator/ajv-formats#readme
- ansi-regex 5.0.1
- ansi-regex 6.6.0
- ansi-styles 4.3.0
- ansi-styles 6.2.3
- archiver 7.0.1 — https://github.com/archiverjs/node-archiver
- archiver-utils 5.0.2 — https://github.com/archiverjs/archiver-utils#readme
- asn1 0.2.6
- assertion-error 2.0.1
- ast-v8-to-istanbul 1.0.8 — https://github.com/AriPerkkio/ast-v8-to-istanbul
- async 3.2.6 — https://caolan.github.io/async/
- async-lock 1.5.0 — https://github.com/rogierschouten/async-lock
- atomic-sleep 1.0.0 — https://github.com/davidmarkclements/atomic-sleep#readme
- avvio 9.3.1 — https://github.com/fastify/avvio#readme
- balanced-match 1.0.2 — https://github.com/juliangruber/balanced-match
- base64-js 1.5.1 — https://github.com/beatgammit/base64-js
- better-auth 1.7.23 — https://better-auth.com
- better-call 1.4.5
- bl 4.1.0 — https://github.com/rvagg/bl
- brace-expansion 2.1.8 — https://github.com/juliangruber/brace-expansion
- buffer 5.7.1 — https://github.com/feross/buffer
- buffer 6.0.3 — https://github.com/feross/buffer
- buffer-crc32 1.0.0 — https://github.com/brianloveswords/buffer-crc32
- buildcheck 0.0.7
- bullmq 6.7.6 — https://bullmq.io/
- byline 5.0.0 — https://github.com/jahewson/node-byline
- chai 6.3.0 — http://chaijs.com
- color-convert 2.0.1
- color-name 1.1.4 — https://github.com/colorjs/color-name
- compress-commons 6.0.2 — https://github.com/archiverjs/node-compress-commons
- cookie 2.0.2
- cookie-es 3.1.1
- core-util-is 1.0.3
- cpu-features 0.0.10
- crc32-stream 6.0.0 — https://github.com/archiverjs/node-crc32-stream
- cron-parser 5.10.4
- cross-spawn 7.0.6 — https://github.com/moxystudio/node-cross-spawn
- csstype 3.2.3
- debug 4.4.3
- defu 6.1.7
- dequal 2.0.3
- docker-compose 1.5.0 — https://pdmlab.github.io/docker-compose/
- eastasianwidth 0.2.0
- emoji-regex 8.0.0 — https://mths.be/emoji-regex
- emoji-regex 9.2.2 — https://mths.be/emoji-regex
- end-of-stream 1.4.5 — https://github.com/mafintosh/end-of-stream
- enhanced-resolve 5.27.0 — https://github.com/webpack/enhanced-resolve#readme
- es-module-lexer 2.3.2 — https://github.com/guybedford/es-module-lexer#readme
- esbuild 0.28.2
- escalade 3.2.0
- estree-walker 3.0.3
- event-target-shim 5.0.1 — https://github.com/mysticatea/event-target-shim
- events 3.3.0
- fast-decode-uri-component 1.0.1 — https://github.com/delvedor/fast-decode-uri-component#readme
- fast-deep-equal 3.1.3 — https://github.com/epoberezkin/fast-deep-equal#readme
- fast-fifo 1.3.2 — https://github.com/mafintosh/fast-fifo
- fast-json-stringify 7.3.5 — https://github.com/fastify/fast-json-stringify#readme
- fast-querystring 1.1.2
- fastify 5.12.8 — https://fastify.dev/
- fdir 6.5.0 — https://github.com/thecodrr/fdir#readme
- find-my-way 9.10.0 — https://github.com/delvedor/find-my-way#readme
- framer-motion 14.13.0
- fs-constants 1.0.0 — https://github.com/mafintosh/fs-constants
- get-port 5.1.1
- ioredis 6.0.0
- ipaddr.js 2.5.0
- is-extglob 2.1.1 — https://github.com/jonschlinkert/is-extglob
- is-fullwidth-code-point 3.0.0
- is-glob 4.0.3 — https://github.com/micromatch/is-glob
- is-stream 2.0.1
- isarray 1.0.0 — https://github.com/juliangruber/isarray
- jiti 2.7.0
- jose 6.2.17 — https://github.com/panva/jose
- js-tokens 10.0.0
- json-schema-ref-resolver 3.0.1 — https://github.com/fastify/json-schema-ref-resolver#readme
- json-schema-traverse 1.0.0 — https://github.com/epoberezkin/json-schema-traverse#readme
- kysely 0.29.9 — https://kysely.dev
- lazystream 1.0.1 — https://github.com/jpommerening/node-lazystream
- lodash 4.18.1 — https://lodash.com/
- lodash.camelcase 4.3.0 — https://lodash.com/
- luxon 3.7.2
- magic-string 1.4.5
- magicast 0.5.5
- mkdirp 3.0.1
- mkdirp-classic 0.5.3 — https://github.com/mafintosh/mkdirp-classic
- motion 14.13.0
- motion-dom 14.13.0
- motion-utils 14.7.0
- mri 1.2.0
- ms 2.1.3
- msgpackr 2.1.4
- msgpackr-extract 3.0.7
- nan 2.30.0
- nanoid 3.3.20
- nanostores 1.5.5
- node-abort-controller 3.1.1 — https://github.com/southpolesteve/node-abort-controller#readme
- node-addon-api 7.1.1 — https://github.com/nodejs/node-addon-api
- node-gyp-build-optional-packages 5.2.2 — https://github.com/prebuild/node-gyp-build
- normalize-path 3.0.0 — https://github.com/jonschlinkert/normalize-path
- obug 3.0.0 — https://github.com/sxzz/obug#readme
- on-exit-leak-free 2.1.2 — https://github.com/mcollina/on-exit-or-gc#readme
- path-key 3.1.1
- pg 8.23.1 — https://github.com/brianc/node-postgres
- pg-cloudflare 1.4.1
- pg-connection-string 2.14.1 — https://github.com/brianc/node-postgres/tree/master/packages/pg-connection-string
- pg-pool 3.14.0 — https://github.com/brianc/node-postgres/tree/master/packages/pg-pool#readme
- pg-protocol 1.16.1
- pg-types 2.2.0 — https://github.com/brianc/node-pg-types
- pgpass 1.0.5
- picomatch 4.0.7 — https://github.com/micromatch/picomatch
- pino 10.4.0 — https://getpino.io
- pino-abstract-transport 3.0.0 — https://github.com/pinojs/pino-abstract-transport#readme
- pino-std-serializers 7.1.0 — https://github.com/pinojs/pino-std-serializers#readme
- postcss 8.5.32 — https://postcss.org/
- postgres-array 2.0.0
- postgres-bytea 1.0.1
- postgres-date 1.0.7
- postgres-interval 1.2.0
- process 0.11.10
- process-nextick-args 2.0.1 — https://github.com/calvinmetcalf/process-nextick-args
- process-warning 5.1.1 — https://github.com/fastify/fastify-warning#readme
- proper-lockfile 4.1.2 — https://github.com/moxystudio/node-proper-lockfile
- properties-reader 3.0.1
- pump 3.0.4
- quick-format-unescaped 4.0.4 — https://github.com/davidmarkclements/quick-format#readme
- react 19.3.1 — https://react.dev/
- react-dom 19.3.1 — https://react.dev/
- readable-stream 2.3.8
- readable-stream 3.6.2
- readable-stream 4.8.0 — https://github.com/nodejs/readable-stream
- real-require 1.0.0 — https://github.com/pinojs/real-require
- redis-errors 1.2.0 — https://github.com/NodeRedis/redis-errors#readme
- require-directory 2.1.1 — https://github.com/troygoode/node-require-directory/
- require-from-string 2.0.2
- ret 0.5.1
- retry 0.12.0 — https://github.com/tim-kos/node-retry
- reusify 1.1.0 — https://github.com/mcollina/reusify#readme
- rfdc 1.4.1 — https://github.com/davidmarkclements/rfdc#readme
- rolldown 1.2.19 — https://rolldown.rs/
- rou3 0.9.2
- safe-buffer 5.1.2 — https://github.com/feross/safe-buffer
- safe-buffer 5.2.1 — https://github.com/feross/safe-buffer
- safe-regex2 5.1.2 — https://github.com/fastify/safe-regex2
- safe-stable-stringify 2.5.0 — https://github.com/BridgeAR/safe-stable-stringify#readme
- safer-buffer 2.1.2
- scheduler 0.28.0 — https://react.dev/
- seroval 1.8.1 — https://seroval.vercel.app
- seroval-plugins 1.8.0 — https://seroval.vercel.app/docs/using-plugins
- set-cookie-parser 3.2.2 — https://github.com/nfriedly/set-cookie-parser
- shebang-command 2.0.0
- shebang-regex 3.0.0
- sonic-boom 4.2.1 — https://github.com/pinojs/sonic-boom#readme
- ssh-remote-port-forward 1.0.4 — https://github.com/cristianrgreco/ssh-remote-port-forward#readme
- ssh2 1.17.0
- standard-as-callback 2.1.0 — https://github.com/luin/asCallback#readme
- std-env 4.3.0
- streamx 2.28.1 — https://github.com/mafintosh/streamx
- string_decoder 1.1.1 — https://github.com/nodejs/string_decoder
- string_decoder 1.3.0 — https://github.com/nodejs/string_decoder
- string-width 4.2.3
- string-width 5.1.2
- strip-ansi 6.0.1
- strip-ansi 7.2.0
- tailwindcss 4.3.5 — https://tailwindcss.com
- tapable 2.3.3 — https://github.com/webpack/tapable
- tar-fs 2.1.5 — https://github.com/mafintosh/tar-fs
- tar-fs 3.1.3 — https://github.com/mafintosh/tar-fs
- tar-stream 2.2.0 — https://github.com/mafintosh/tar-stream
- tar-stream 3.2.2 — https://github.com/mafintosh/tar-stream
- teex 1.0.1 — https://github.com/mafintosh/teex
- testcontainers 12.2.1 — https://github.com/testcontainers/testcontainers-node#readme
- thread-stream 4.2.1 — https://github.com/mcollina/thread-stream#readme
- tinybench 6.2.3 — https://github.com/tinylibs/tinybench#readme
- tinyexec 1.3.1 — https://github.com/tinylibs/tinyexec#readme
- tinyglobby 0.2.17 — https://superchupu.dev/tinyglobby
- tinyrainbow 3.2.0 — https://github.com/tinylibs/tinyrainbow#readme
- tmp 0.2.7 — http://github.com/raszi/node-tmp
- toad-cache 3.7.4 — https://github.com/kibertoad/toad-cache
- tsx 4.23.15 — https://tsx.hirok.io
- turbo 2.11.11 — https://turborepo.dev
- undici 8.12.4 — https://undici.nodejs.org
- undici-types 5.26.5 — https://undici.nodejs.org
- undici-types 6.21.0 — https://undici.nodejs.org
- use-sync-external-store 1.7.0
- util-deprecate 1.0.2 — https://github.com/TooTallNate/util-deprecate
- vite 8.3.8 — https://vite.dev
- vitest 5.1.0 — https://vitest.dev
- why-is-node-running 3.2.1 — https://github.com/mafintosh/why-is-node-running
- wrap-ansi 7.0.0
- wrap-ansi 8.1.0
- xtend 4.0.2 — https://github.com/Raynos/xtend
- yargs 17.7.3 — https://yargs.js.org/
- zip-stream 6.0.1 — https://github.com/archiverjs/node-zip-stream
- zod 4.6.7 — https://zod.dev

### Apache-2.0 (27)

- @balena/dockerignore 1.0.2
- @grpc/grpc-js 1.14.7 — https://grpc.io/
- @grpc/proto-loader 0.7.15 — https://grpc.io/
- @grpc/proto-loader 0.8.1 — https://grpc.io/
- @playwright/test 1.65.0 — https://playwright.dev
- b4a 1.9.0 — https://github.com/holepunchto/b4a#readme
- bare-buffer 3.7.2 — https://github.com/holepunchto/bare-buffer#readme
- bare-events 2.9.2 — https://github.com/holepunchto/bare-events#readme
- bare-fs 4.8.4 — https://github.com/holepunchto/bare-fs#readme
- bare-path 3.1.3 — https://github.com/holepunchto/bare-path#readme
- bare-stream 2.13.4 — https://github.com/holepunchto/bare-stream#readme
- bare-url 2.5.7 — https://github.com/holepunchto/bare-url
- cluster-key-slot 1.1.1 — https://github.com/Salakar/cluster-key-slot#readme
- crc-32 1.2.2 — https://sheetjs.com/
- denque 2.1.0 — https://docs.page/invertase/denque
- detect-libc 2.1.2
- docker-modem 5.0.7
- dockerode 5.0.1
- drizzle-orm 0.45.4 — https://orm.drizzle.team
- events-universal 1.0.1 — https://github.com/holepunchto/events-universal#readme
- expect-type 1.4.0 — https://github.com/mmkal/expect-type#readme
- long 5.3.2
- playwright 1.65.0 — https://playwright.dev
- playwright-core 1.65.0 — https://playwright.dev
- readdir-glob 1.1.3 — https://github.com/Yqnn/node-readdir-glob
- text-decoder 1.2.7 — https://github.com/holepunchto/text-decoder#readme
- typescript 5.9.3 — https://www.typescriptlang.org/

### ISC (26)

- @isaacs/cliui 8.0.2
- chownr 1.1.4
- cliui 8.0.1
- fastq 1.20.3 — https://github.com/mcollina/fastq#readme
- foreground-child 3.3.1
- get-caller-file 2.0.5 — https://github.com/stefanpenner/get-caller-file#readme
- glob 10.5.0
- inherits 2.0.4
- isexe 2.0.0 — https://github.com/isaacs/isexe#readme
- lru-cache 10.4.3
- lucide-react 1.72.0 — https://lucide.dev
- minimatch 5.1.9
- minimatch 9.0.9
- once 1.4.0
- pg-int8 1.0.1
- picocolors 1.1.1
- semver 7.8.6
- signal-exit 3.0.7 — https://github.com/tapjs/signal-exit
- signal-exit 4.1.0
- split-ca 1.0.1 — https://github.com/bushong1/split-ca
- split2 4.2.0
- which 2.0.2
- wrappy 1.0.2 — https://github.com/npm/wrappy
- y18n 5.0.8 — https://github.com/yargs/y18n
- yaml 2.9.1 — https://eemeli.org/yaml/
- yargs-parser 21.1.1

### BSD-3-Clause (17)

- @protobufjs/aspromise 1.1.2
- @protobufjs/base64 1.1.2
- @protobufjs/codegen 2.0.5
- @protobufjs/eventemitter 1.1.1
- @protobufjs/fetch 1.1.1
- @protobufjs/float 1.0.2
- @protobufjs/path 1.1.2
- @protobufjs/pool 1.1.0
- @protobufjs/utf8 1.1.2
- bcrypt-pbkdf 1.0.2
- fast-uri 3.1.9 — https://github.com/fastify/fast-uri
- fast-uri 4.2.3 — https://github.com/fastify/fast-uri
- ieee754 1.2.1
- light-my-request 6.8.0 — https://github.com/fastify/light-my-request#readme
- protobufjs 7.6.6 — https://protobufjs.github.io/protobuf.js/
- secure-json-parse 4.1.1 — https://github.com/fastify/secure-json-parse#readme
- source-map-js 1.2.2 — https://github.com/7rulnik/source-map-js

### BlueOak-1.0.0 (5)

- graceful-fs 4.2.12
- jackspeak 3.4.3
- minipass 7.1.3
- package-json-from-dist 1.0.1
- path-scurry 1.11.1

### OFL-1.1 (3)

- @fontsource/ibm-plex-mono 5.3.0 — https://fontsource.org/fonts/ibm-plex-mono
- @fontsource/ibm-plex-sans 5.3.0 — https://fontsource.org/fonts/ibm-plex-sans
- @fontsource/ibm-plex-sans-arabic 5.3.0 — https://fontsource.org/fonts/ibm-plex-sans-arabic

### Unlicense (2)

- isbot 5.2.3 — https://isbot.js.org
- tweetnacl 0.14.5 — https://tweetnacl.js.org

### 0BSD (1)

- tslib 2.9.1 — https://www.typescriptlang.org/

### MIT OR Apache-2.0 (1)

- @biomejs/biome 2.6.7 — https://biomejs.dev

### MPL-2.0 (1)

- lightningcss 1.33.0

<!-- END GENERATED -->
