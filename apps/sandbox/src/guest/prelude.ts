/**
 * The guest API as guest code (ADR-023 §1). This text is evaluated by QuickJS inside the fresh
 * context, never by Node. It is one function expression; the runner calls it once with the bridge
 * (`call`, `emit`) and the exec's configuration as a JSON string, before the code runs.
 *
 * - The bridge stays in this closure. Nothing named after it is put on the global object.
 * - Every intrinsic it needs is captured here, before the code can replace it. A guest that later
 *   replaces built-ins can only break its own run: only JSON text crosses the bridge.
 * - It returns `snapshot`, a function the runner calls after the code's promise settled; it gives
 *   the scope patches as JSON text (ADR-023 §2).
 *
 * Kept as plain ES2020 so it reads the same in any QuickJS build.
 */
export const PRELUDE_NAME = "guest.js";

export const PRELUDE = `(function install(call, emit, configText) {
  "use strict";
  const G = globalThis;
  const O = Object;
  const freeze = O.freeze;
  const defineProperty = O.defineProperty;
  const keys = O.keys;
  const getOwnPropertyNames = O.getOwnPropertyNames;
  const hasOwn = (o, k) => O.prototype.hasOwnProperty.call(o, k);
  const isArray = Array.isArray;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const PromiseC = Promise;
  const reject = (e) => PromiseC.reject(e);
  const ErrorC = Error;
  const TypeErrorC = TypeError;
  const StringC = String;
  const encode = encodeURIComponent;

  const config = parse(configText);

  function deepFreeze(value) {
    if (value !== null && typeof value === "object" && !O.isFrozen(value)) {
      freeze(value);
      const names = getOwnPropertyNames(value);
      for (let i = 0; i < names.length; i++) deepFreeze(value[names[i]]);
    }
    return value;
  }

  function constant(target, name, value) {
    defineProperty(target, name, { value: value, writable: false, enumerable: true, configurable: false });
  }

  function asObject(value) {
    return value !== null && typeof value === "object" && !isArray(value) ? value : {};
  }

  const scopes = asObject(config.scopes);
  const MUTABLE = ["workflow", "conversation", "user", "turn"];
  const FROZEN = ["bot", "event", "env"];

  for (let i = 0; i < FROZEN.length; i++) constant(G, FROZEN[i], deepFreeze(asObject(scopes[FROZEN[i]])));

  if (config.kind === "expressions") {
    // ADR-018 §3: every scope is read-only and nothing else is installed.
    for (let i = 0; i < MUTABLE.length; i++) constant(G, MUTABLE[i], deepFreeze(asObject(scopes[MUTABLE[i]])));
    return undefined;
  }

  const user = asObject(scopes.user);
  const attributes = deepFreeze(asObject(user.attributes));
  delete user.attributes;
  defineProperty(user, "attributes", { value: attributes, writable: false, enumerable: false, configurable: false });

  const mutable = {
    workflow: asObject(scopes.workflow),
    conversation: asObject(scopes.conversation),
    user: user,
    turn: asObject(scopes.turn),
  };
  for (let i = 0; i < MUTABLE.length; i++) constant(G, MUTABLE[i], mutable[MUTABLE[i]]);

  // One JSON text per top-level variable, to diff against after the run.
  function texts(scope) {
    const out = {};
    const obj = mutable[scope];
    const names = keys(obj);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      let text;
      try {
        text = stringify(obj[name]);
      } catch (e) {
        throw new TypeErrorC(scope + "." + name + " cannot be saved: " + (e && e.message));
      }
      if (text !== undefined) out[name] = text;
    }
    return out;
  }
  const baseline = {};
  for (let i = 0; i < MUTABLE.length; i++) baseline[MUTABLE[i]] = texts(MUTABLE[i]);

  function snapshot() {
    const patches = {};
    for (let i = 0; i < MUTABLE.length; i++) {
      const scope = MUTABLE[i];
      const before = baseline[scope];
      const after = texts(scope);
      const set = {};
      const unset = [];
      let changed = false;
      const names = keys(after);
      for (let j = 0; j < names.length; j++) {
        if (before[names[j]] !== after[names[j]]) {
          set[names[j]] = parse(after[names[j]]);
          changed = true;
        }
      }
      const old = keys(before);
      for (let j = 0; j < old.length; j++) {
        if (!hasOwn(after, old[j])) {
          unset.push(old[j]);
          changed = true;
        }
      }
      if (changed) {
        const patch = {};
        if (keys(set).length > 0) patch.set = set;
        if (unset.length > 0) patch.unset = unset;
        patches[scope] = patch;
      }
    }
    return stringify(patches);
  }

  // A call that fails rejects with an Error made when the call was made, so its stack points at
  // the line of the code that called (ADR-023 §8).
  function invoke(op, input, site) {
    let text;
    try {
      text = stringify(input);
    } catch (e) {
      return reject(e);
    }
    return call(op, text).then(function (answer) {
      const r = parse(answer);
      if (r.ok) return r.value;
      site.message = StringC(r.message);
      site.code = StringC(r.code);
      throw site;
    });
  }

  function say(message) {
    const site = new ErrorC();
    if (typeof message === "string") return invoke("say", { message: { type: "text", text: message } }, site).then(nothing);
    if (message === null || typeof message !== "object") return reject(new TypeErrorC("say needs a string or a message"));
    return invoke("say", { message: message }, site).then(nothing);
  }
  function nothing() {
    return undefined;
  }

  const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

  function headerMap(list) {
    const map = {};
    for (let i = 0; i < list.length; i++) {
      const name = StringC(list[i][0]).toLowerCase();
      map[name] = hasOwn(map, name) ? map[name] + ", " + list[i][1] : StringC(list[i][1]);
    }
    return map;
  }

  function request(url, init, site) {
    if (typeof url !== "string") return reject(new TypeErrorC("fetch needs a URL string"));
    const options = init === undefined ? {} : init;
    if (options === null || typeof options !== "object") return reject(new TypeErrorC("fetch options must be an object"));
    const method = options.method === undefined ? "GET" : StringC(options.method).toUpperCase();
    if (METHODS.indexOf(method) < 0) return reject(new TypeErrorC("fetch does not support the method " + method));
    const headers = {};
    if (options.headers !== undefined) {
      if (options.headers === null || typeof options.headers !== "object") return reject(new TypeErrorC("fetch headers must be an object"));
      const names = keys(options.headers);
      for (let i = 0; i < names.length; i++) {
        const value = options.headers[names[i]];
        if (typeof value !== "string") return reject(new TypeErrorC("the header " + names[i] + " must be a string"));
        headers[names[i]] = value;
      }
    }
    if (options.body !== undefined && typeof options.body !== "string") return reject(new TypeErrorC("fetch body must be a string"));
    const input = { url: url, method: method, headers: headers };
    if (options.body !== undefined) input.body = options.body;
    return invoke("fetch", input, site);
  }

  function makeResponse(r) {
    const map = headerMap(r.headers);
    const body = StringC(r.body);
    return freeze({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.statusText,
      url: r.url,
      headers: freeze({
        get: function (name) {
          const key = StringC(name).toLowerCase();
          return hasOwn(map, key) ? map[key] : null;
        },
      }),
      text: function () {
        return PromiseC.resolve(body);
      },
      json: function () {
        return PromiseC.resolve().then(function () {
          return parse(body);
        });
      },
    });
  }

  function guestFetch(url, init) {
    return request(url, init, new ErrorC()).then(makeResponse);
  }

  function withParams(url, params) {
    if (params === undefined || params === null) return url;
    const names = keys(params);
    if (names.length === 0) return url;
    const parts = [];
    for (let i = 0; i < names.length; i++) parts.push(encode(names[i]) + "=" + encode(StringC(params[names[i]])));
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + parts.join("&");
  }

  function axiosCall(method, url, data, config) {
    const site = new ErrorC();
    const options = config === undefined || config === null ? {} : config;
    const headers = {};
    const given = options.headers === undefined || options.headers === null ? {} : options.headers;
    const names = keys(given);
    let hasType = false;
    for (let i = 0; i < names.length; i++) {
      headers[names[i]] = given[names[i]];
      if (names[i].toLowerCase() === "content-type") hasType = true;
    }
    const init = { method: method, headers: headers };
    if (data !== undefined) {
      try {
        init.body = typeof data === "string" ? data : stringify(data);
      } catch (e) {
        return reject(e);
      }
      if (!hasType) headers["content-type"] = typeof data === "string" ? "text/plain; charset=utf-8" : "application/json";
    }
    return request(withParams(StringC(url), options.params), init, site).then(function (r) {
      let body = StringC(r.body);
      let value = body;
      try {
        value = parse(body);
      } catch (e) {
        value = body;
      }
      const response = freeze({ status: r.status, statusText: r.statusText, headers: freeze(headerMap(r.headers)), data: value });
      if (r.status < 200 || r.status >= 300) {
        site.message = "Request failed with status code " + r.status;
        site.code = "fetch_failed";
        site.status = r.status;
        site.response = response;
        throw site;
      }
      return response;
    });
  }

  const axios = freeze({
    get: function (url, config) {
      return axiosCall("GET", url, undefined, config);
    },
    delete: function (url, config) {
      return axiosCall("DELETE", url, undefined, config);
    },
    post: function (url, data, config) {
      return axiosCall("POST", url, data, config);
    },
    put: function (url, data, config) {
      return axiosCall("PUT", url, data, config);
    },
    patch: function (url, data, config) {
      return axiosCall("PATCH", url, data, config);
    },
  });

  function table(name) {
    const op = function (kind, input) {
      input.table = name;
      return invoke("tables." + kind, input, new ErrorC());
    };
    return freeze({
      find: function (options) {
        const input = {};
        const o = options === undefined || options === null ? {} : options;
        const names = keys(o);
        for (let i = 0; i < names.length; i++) input[names[i]] = o[names[i]];
        return op("find", input);
      },
      get: function (where) {
        return op("get", { where: where });
      },
      insert: function (values) {
        return op("insert", { values: values });
      },
      update: function (where, values) {
        return op("update", { where: where, values: values });
      },
      upsert: function (values, on) {
        return op("upsert", { values: values, on: on });
      },
      delete: function (where) {
        return op("delete", { where: where });
      },
    });
  }

  const tables = {};
  const tableNames = isArray(config.tables) ? config.tables : [];
  for (let i = 0; i < tableNames.length; i++) constant(tables, StringC(tableNames[i]), table(StringC(tableNames[i])));
  freeze(tables);

  function withOptions(base, options) {
    const input = base;
    if (options !== undefined && options !== null) {
      const names = keys(options);
      for (let i = 0; i < names.length; i++) input[names[i]] = options[names[i]];
    }
    return input;
  }

  const kb = freeze({
    search: function (query, options) {
      return invoke("kb.search", withOptions({ query: query }, options), new ErrorC());
    },
  });

  const ai = freeze({
    generate: function (options) {
      return invoke("ai.generate", withOptions({}, options), new ErrorC());
    },
    extract: function (options) {
      return invoke("ai.extract", withOptions({}, options), new ErrorC());
    },
    classify: function (options) {
      return invoke("ai.classify", withOptions({}, options), new ErrorC());
    },
  });

  function logArg(value) {
    if (typeof value === "string") return value;
    let text;
    try {
      text = stringify(value);
    } catch (e) {
      text = undefined;
    }
    if (text === undefined) {
      try {
        return StringC(value);
      } catch (e) {
        return "a value that cannot be shown";
      }
    }
    return parse(text);
  }
  function logger(level) {
    return function () {
      const args = [];
      for (let i = 0; i < arguments.length; i++) args.push(logArg(arguments[i]));
      emit(level, stringify(args));
    };
  }
  const log = freeze({ info: logger("info"), warn: logger("warn"), error: logger("error") });

  const ctx = freeze({ idempotencyKey: StringC(config.idempotencyKey) });

  constant(G, "say", say);
  constant(G, "fetch", guestFetch);
  constant(G, "axios", axios);
  constant(G, "tables", tables);
  constant(G, "kb", kb);
  constant(G, "ai", ai);
  constant(G, "log", log);
  constant(G, "ctx", ctx);

  return snapshot;
})`;
